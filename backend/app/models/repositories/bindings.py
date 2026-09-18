"""bindings 表数据访问。

绑定 = 版本 × 区域 → 块（一区域一版本只绑一块，UNIQUE(version_id, region_id)）；
块软删除后的 missing 降级态由 blocks.soft_delete_block 在同事务内完成，此处不重复提供。
"""

import sqlite3

from app.models.db import utcnow
from app.models.entities import Binding

_SELECT = (
    "SELECT id, version_id, region_id, block_id, status, created_at, updated_at FROM bindings"
)


def upsert_binding(
    conn: sqlite3.Connection, version_id: int, region_id: int, block_id: int
) -> Binding:
    """绑定/换绑（同 version+region 冲突时覆盖 block_id 并重置为 active）。

    重绑到软删除块的场景由 M6 service 层校验拦截；存储层不重复守门。
    """
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO bindings (version_id, region_id, block_id, status, created_at, updated_at) "
        "VALUES (?, ?, ?, 'active', ?, ?) "
        "ON CONFLICT (version_id, region_id) DO UPDATE SET "
        "block_id = excluded.block_id, status = 'active', updated_at = excluded.updated_at",
        (version_id, region_id, block_id, now, now),
    )
    assert cur.lastrowid is not None
    binding = conn.execute(f"{_SELECT} WHERE version_id = ? AND region_id = ?",
                           (version_id, region_id)).fetchone()
    assert binding is not None
    return Binding.from_row(binding)


def get_binding(conn: sqlite3.Connection, version_id: int, region_id: int) -> Binding | None:
    """按业务键取绑定（version + region 唯一）。"""
    row = conn.execute(
        f"{_SELECT} WHERE version_id = ? AND region_id = ?", (version_id, region_id)
    ).fetchone()
    return Binding.from_row(row) if row else None


def delete_binding(conn: sqlite3.Connection, binding_id: int) -> bool:
    """物理删除绑定（解绑）；目标不存在返回 False（幂等）。"""
    cur = conn.execute("DELETE FROM bindings WHERE id = ?", (binding_id,))
    return cur.rowcount > 0


def list_bindings(conn: sqlite3.Connection, version_id: int) -> list[Binding]:
    """版本的绑定列表（含 missing 态——导出时需对缺失绑定留空并提示）。"""
    rows = conn.execute(
        f"{_SELECT} WHERE version_id = ? ORDER BY region_id", (version_id,)
    ).fetchall()
    return [Binding.from_row(r) for r in rows]
