"""Validated, portable library backups. Call while the API library gate is held."""

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
import zipfile
from contextlib import closing
from io import BytesIO
from pathlib import Path, PurePosixPath

from app.core.config import settings
from app.core.errors import AppError
from app.models.db import get_conn, init_db, utcnow

MAX_BACKUP_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024


def _foreign_keys(database: sqlite3.Connection, table: str) -> list[tuple[object, ...]]:
    return sorted(tuple(row)[2:] for row in database.execute(f'PRAGMA foreign_key_list("{table}")'))


def backup_directory() -> Path:
    directory = settings.db_path.parent / "backups"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def create_backup() -> bytes:
    with tempfile.TemporaryDirectory(prefix="modudoc-backup-") as directory:
        database = Path(directory) / "app.db"
        with get_conn() as source, closing(sqlite3.connect(database)) as destination:
            source.backup(destination)
        expanded_size = database.stat().st_size
        if expanded_size > MAX_EXPANDED_BYTES:
            raise AppError("BACKUP_TOO_LARGE", "资料库超过 512 MiB，请退出应用后复制数据目录备份")
        files = {"app.db": database.read_bytes()}
        with closing(sqlite3.connect(database)) as conn:
            for name, digest in conn.execute("SELECT storage_name,sha256 FROM templates"):
                if Path(name).name != name or "\\" in name:
                    raise AppError("BACKUP_INVALID", "模板路径异常，无法备份")
                path = settings.templates_dir / name
                if not path.is_file():
                    raise AppError("BACKUP_INVALID", "模板原件缺失，无法创建完整备份")
                expanded_size += path.stat().st_size
                if expanded_size > MAX_EXPANDED_BYTES:
                    raise AppError(
                        "BACKUP_TOO_LARGE", "资料库超过 512 MiB，请退出应用后复制数据目录备份"
                    )
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() != digest:
                    raise AppError("BACKUP_INVALID", "模板校验失败，无法创建完整备份")
                files[f"templates/{name}"] = data
        if sum(map(len, files.values())) > MAX_EXPANDED_BYTES:
            raise AppError("BACKUP_TOO_LARGE", "资料库超过 512 MiB，请退出应用后复制数据目录备份")
        manifest = {
            "format": "modudoc-library",
            "version": 1,
            "created_at": utcnow(),
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        }
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        data = buffer.getvalue()
        if len(data) > MAX_BACKUP_BYTES:
            raise AppError("BACKUP_TOO_LARGE", "备份超过 256 MiB，请退出应用后复制数据目录备份")
        return data


def _unpack(data: bytes, target: Path) -> dict[str, int]:
    if len(data) > MAX_BACKUP_BYTES:
        raise ValueError("备份超过 256 MiB")
    with zipfile.ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if len(names) != len(set(names)) or len(names) > 10000:
            raise ValueError("备份含重复或过多文件")
        if sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("解压内容超过 512 MiB")
        for item in entries:
            path = PurePosixPath(item.filename)
            allowed = item.filename in {"app.db", "manifest.json"} or (
                len(path.parts) == 2
                and path.parts[0] == "templates"
                and path.parts[1] not in {".", ".."}
            )
            if (
                not allowed
                or "\\" in item.filename
                or (item.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError("备份包含不允许的路径")
        manifest = json.loads(archive.read("manifest.json"))
        if (
            not isinstance(manifest, dict)
            or manifest.get("format") != "modudoc-library"
            or manifest.get("version") != 1
        ):
            raise ValueError("不支持此备份格式")
        hashes = manifest.get("files")
        if not isinstance(hashes, dict) or set(hashes) != set(names) - {"manifest.json"}:
            raise ValueError("备份文件清单不完整")
        for name, digest in hashes.items():
            content = archive.read(name)
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("备份文件校验失败")
            path = target / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    database = target / "app.db"
    if not database.is_file():
        raise ValueError("备份缺少数据库")
    with closing(sqlite3.connect(database)) as conn:
        conn.execute("PRAGMA trusted_schema=OFF")
        if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("备份数据库损坏")
        if conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')"
        ).fetchone()[0]:
            raise ValueError("备份含不支持的数据库对象")
        with get_conn(":memory:") as reference:
            init_db(reference)
            expected = {
                r[0] for r in reference.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            for table in expected - {"sqlite_sequence"}:
                expected_columns = {
                    r[1]: tuple(r)[2:] for r in reference.execute(f'PRAGMA table_info("{table}")')
                }
                actual_columns = {
                    r[1]: tuple(r)[2:] for r in conn.execute(f'PRAGMA table_info("{table}")')
                }
                if expected_columns != actual_columns or _foreign_keys(
                    reference, table
                ) != _foreign_keys(conn, table):
                    raise ValueError("备份数据库结构不兼容")
        actual = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if actual != expected:
            raise ValueError("备份数据库版本不兼容")
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("备份关联数据不完整")
        template_files = set()
        for name, digest in conn.execute("SELECT storage_name,sha256 FROM templates"):
            key = f"templates/{name}"
            if key not in hashes or hashes[key] != digest:
                raise ValueError("备份模板指纹不匹配")
            template_files.add(key)
        if template_files != {name for name in hashes if name.startswith("templates/")}:
            raise ValueError("备份包含未登记的模板")
        for docx, pdf, docx_sha, pdf_sha in conn.execute(
            "SELECT docx,pdf,docx_sha256,pdf_sha256 FROM archives"
        ):
            if (
                hashlib.sha256(docx).hexdigest() != docx_sha
                or hashlib.sha256(pdf).hexdigest() != pdf_sha
            ):
                raise ValueError("冻结归档校验失败")
        return {
            table: conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in ("templates", "versions", "blocks", "archives")
        }


def inspect_backup(data: bytes) -> dict[str, object]:
    try:
        with tempfile.TemporaryDirectory(prefix="modudoc-inspect-") as directory:
            counts = _unpack(data, Path(directory))
        return {"sha256": hashlib.sha256(data).hexdigest(), "counts": counts}
    except (
        ValueError,
        KeyError,
        TypeError,
        OSError,
        RuntimeError,
        sqlite3.Error,
        zipfile.BadZipFile,
    ) as exc:
        raise AppError("BACKUP_INVALID", f"备份验证失败：{exc}") from exc


def restore_backup(data: bytes, expected_sha256: str) -> str:
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise AppError("BACKUP_CHANGED", "备份文件已变化，请重新选择并核对", status_code=409)
    inspect_backup(data)
    root = Path(tempfile.mkdtemp(prefix=".modudoc-restore-", dir=settings.db_path.parent))
    cleanup = True
    try:
        staged, old = root / "new", root / "old"
        staged.mkdir()
        old.mkdir()
        _unpack(data, staged)
        (staged / "templates").mkdir(exist_ok=True)
        # Keep a portable rollback backup before touching any live file.
        name = f"before-restore-{uuid.uuid4().hex}.zip"
        (backup_directory() / name).write_bytes(create_backup())
        with get_conn() as conn:
            result = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if result[0] != 0:
                raise AppError("RESTORE_BUSY", "资料库仍被其他进程使用，请关闭其他实例后重试", 409)
        moved: list[tuple[Path, Path]] = []
        installed: list[Path] = []
        try:
            for live in (settings.db_path, settings.templates_dir):
                saved = old / live.name
                if live.exists():
                    os.replace(live, saved)
                    moved.append((live, saved))
            for source, live in (
                (staged / "app.db", settings.db_path),
                (staged / "templates", settings.templates_dir),
            ):
                os.replace(source, live)
                installed.append(live)
        except OSError as exc:
            try:
                for live in reversed(installed):
                    os.replace(live, staged / live.name)
                for live, saved in reversed(moved):
                    os.replace(saved, live)
            except OSError as rollback_error:
                cleanup = False
                raise AppError(
                    "RESTORE_FAILED", f"恢复中断，原件保留在 {root}，另有恢复前完整备份", 500
                ) from rollback_error
            raise AppError("RESTORE_FAILED", "恢复失败，已保留原资料库与恢复前备份", 500) from exc
    finally:
        if cleanup:
            shutil.rmtree(root, ignore_errors=True)
    return name
