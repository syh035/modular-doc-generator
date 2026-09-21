"""版本管理业务（M8）：新建（空白 / 复制当前为底稿）、重命名、删除保护。

- 版本归属模板，同模板内命名唯一（UNIQUE 约束兜底，业务层捕获转可读 409）
- 名称 1–30 字符在 API 层校验（与 blocks 同范式），此处只管业务规则
- 复制底稿：仅复制源版本 active 绑定（missing 态不迁移——异常态不扩散）
- 删除保护：模板至少保留一个版本（LAST_VERSION）
"""

import sqlite3

from app.core.errors import (
    LAST_VERSION,
    VERSION_INVALID,
    VERSION_NAME_TAKEN,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.entities import Version
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import versions as versions_repo


def list_versions_with_counts(
    conn: sqlite3.Connection, template_id: int
) -> list[dict[str, object]]:
    """模板版本列表（创建正序）+ active 绑定数（下拉展示用）。"""
    versions = versions_repo.list_versions(conn, template_id)
    counts = dict.fromkeys((v.id for v in versions), 0)
    if versions:
        placeholders = ",".join("?" * len(versions))
        cur = conn.execute(
            "SELECT version_id, COUNT(*) FROM bindings "
            f"WHERE status = 'active' AND version_id IN ({placeholders}) GROUP BY version_id",
            [v.id for v in versions],
        )
        for version_id, n in cur.fetchall():
            counts[int(version_id)] = int(n)
    return [
        {
            "id": v.id,
            "template_id": v.template_id,
            "name": v.name,
            "binding_count": counts[v.id],
            "created_at": v.created_at,
            "updated_at": v.updated_at,
        }
        for v in versions
    ]


def create_version(
    conn: sqlite3.Connection, template_id: int, name: str, copy_from: int | None = None
) -> Version:
    """新建版本；copy_from 指定源版本时复制其 active 绑定为底稿。"""
    source_bindings: list[tuple[int, int]] = []
    if copy_from is not None:
        source = versions_repo.get_version(conn, copy_from)
        if source is None:
            raise AppError(
                VERSION_NOT_FOUND, f"复制源版本不存在（id={copy_from}）", status_code=404
            )
        if source.template_id != template_id:
            raise AppError(
                VERSION_INVALID, f"复制源版本（id={copy_from}）不属于该模板", status_code=400
            )
        source_bindings = [
            (b.region_id, b.block_id)
            for b in bindings_repo.list_bindings(conn, copy_from)
            if b.status == "active"
        ]
    try:
        ver = versions_repo.create_version(conn, template_id, name)
    except sqlite3.IntegrityError as exc:
        raise AppError(
            VERSION_NAME_TAKEN, f"同模板下已存在同名版本「{name}」", status_code=409
        ) from exc
    for region_id, block_id in source_bindings:
        bindings_repo.upsert_binding(conn, ver.id, region_id, block_id)
    return ver


def rename_version(conn: sqlite3.Connection, version_id: int, new_name: str) -> Version:
    """重命名（同模板内唯一）。"""
    if versions_repo.get_version(conn, version_id) is None:
        raise AppError(VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404)
    try:
        ver = versions_repo.rename_version(conn, version_id, new_name)
        assert ver is not None  # 前置 get 已确认存在
        return ver
    except sqlite3.IntegrityError as exc:
        raise AppError(
            VERSION_NAME_TAKEN, f"同模板下已存在同名版本「{new_name}」", status_code=409
        ) from exc


def delete_version(conn: sqlite3.Connection, version_id: int) -> None:
    """删除版本（绑定随 FK CASCADE）；模板至少保留一个版本。"""
    ver = versions_repo.get_version(conn, version_id)
    if ver is None:
        raise AppError(VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404)
    siblings = versions_repo.list_versions(conn, ver.template_id)
    if len(siblings) <= 1:
        raise AppError(
            LAST_VERSION,
            f"模板（id={ver.template_id}）至少保留一个内容版本",
            status_code=400,
        )
    assert versions_repo.delete_version(conn, version_id)
