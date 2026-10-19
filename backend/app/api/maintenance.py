"""Local library maintenance; cached previews are disposable, source documents are not."""

from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response

from app.core.config import settings
from app.core.errors import AppError
from app.services import backup_service, render_service, render_sessions
from app.services.libreoffice import LibreOfficeManager

router = APIRouter(prefix="/api/maintenance")


def get_manager() -> LibreOfficeManager:
    # Cache management/restore must remain available even if LibreOffice is missing.
    return LibreOfficeManager(
        "",
        profile_dir=settings.lo_profile_dir,
        cache_dir=settings.render_cache_dir,
        timeout_seconds=30,
    )


@router.get("/cache")
def cache_status() -> dict[str, int]:
    return get_manager().cache_status()


@router.delete("/cache")
def clear_cache() -> dict[str, int]:
    return get_manager().clear_cache()


def _read_backup(file: UploadFile) -> bytes:
    data = file.file.read(backup_service.MAX_BACKUP_BYTES + 1)
    if len(data) > backup_service.MAX_BACKUP_BYTES:
        raise AppError("BACKUP_TOO_LARGE", "备份文件不能超过 256 MiB")
    return data


@router.post("/backup")
def backup() -> Response:
    return Response(
        backup_service.create_backup(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="modudoc-backup.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/restore/inspect")
def inspect(file: Annotated[UploadFile, File()]) -> dict[str, object]:
    return backup_service.inspect_backup(_read_backup(file))


@router.post("/restore")
def restore(
    file: Annotated[UploadFile, File()],
    expected_sha256: Annotated[str, Form()],
    confirm: Annotated[bool, Form()] = False,
) -> dict[str, str]:
    if not confirm:
        raise AppError("RESTORE_CONFIRM_REQUIRED", "请确认替换当前资料库", 409)
    name = backup_service.restore_backup(_read_backup(file), expected_sha256)
    get_manager().clear_cache()
    render_service.clear_render_results()
    render_sessions.clear()
    return {"backup_name": name}


@router.get("/backups")
def backups() -> dict[str, object]:
    return {
        "backups": [
            {"name": p.name, "bytes": p.stat().st_size}
            for p in sorted(
                backup_service.backup_directory().glob("*.zip"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        ]
    }


@router.get("/backups/{name}")
def download_backup(name: str) -> Response:
    if (
        not name.startswith("before-restore-")
        or not name.endswith(".zip")
        or "/" in name
        or "\\" in name
    ):
        raise AppError("BACKUP_NOT_FOUND", "备份不存在", 404)
    path = backup_service.backup_directory() / name
    if not path.is_file():
        raise AppError("BACKUP_NOT_FOUND", "备份不存在", 404)
    return Response(
        path.read_bytes(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "no-store",
        },
    )
