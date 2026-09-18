"""blocks 表数据访问。

块是内容资产主体：只软删除（D11），不做物理删除路由；
字段业务校验（名称 2–30 字 / 内容 ≤5000 字 / 标签 ≤10 个）属 M2 service 层职责，此处纯存储。
分类功能已移除（2026-09-18 用户确认），块列表平铺按更新时间倒序。
"""

import sqlite3

from app.models.db import utcnow
from app.models.entities import Block

_SELECT = "SELECT id, name, content, created_at, updated_at, deleted_at FROM blocks"


def create_block(conn: sqlite3.Connection, name: str, content: str) -> Block:
    """新建块并回读完整行。"""
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO blocks (name, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (name, content, now, now),
    )
    assert cur.lastrowid is not None
    block = get_block(conn, cur.lastrowid)
    assert block is not None  # 刚插入的行必然可读
    return block


def get_block(
    conn: sqlite3.Connection, block_id: int, *, include_deleted: bool = False
) -> Block | None:
    """按 id 取块；默认排除软删除行。"""
    sql = f"{_SELECT} WHERE id = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    row = conn.execute(sql, (block_id,)).fetchone()
    return Block.from_row(row) if row else None


def list_blocks(
    conn: sqlite3.Connection,
    *,
    include_deleted: bool = False,
) -> list[Block]:
    """块列表（平铺，按更新时间倒序——最近编辑的块排前面）；默认排除软删除行。"""
    sql = _SELECT
    if not include_deleted:
        sql += " WHERE deleted_at IS NULL"
    sql += " ORDER BY updated_at DESC, id DESC"
    rows = conn.execute(sql).fetchall()
    return [Block.from_row(r) for r in rows]


def update_block(
    conn: sqlite3.Connection,
    block_id: int,
    *,
    name: str | None = None,
    content: str | None = None,
) -> Block | None:
    """部分更新（仅传入的字段）；目标不存在或已软删除时返回 None。"""
    sets: list[str] = []
    params: list[object] = []
    if name is not None:
        sets.append("name = ?")
        params.append(name)
    if content is not None:
        sets.append("content = ?")
        params.append(content)
    if not sets:
        return get_block(conn, block_id)
    sets.append("updated_at = ?")
    params.append(utcnow())
    params.append(block_id)
    cur = conn.execute(
        f"UPDATE blocks SET {', '.join(sets)} WHERE id = ? AND deleted_at IS NULL", params
    )
    if cur.rowcount == 0:
        return None
    block = get_block(conn, block_id)
    assert block is not None
    return block


def soft_delete_block(conn: sqlite3.Connection, block_id: int) -> bool:
    """软删除块（D11）：置 deleted_at，绑定同事务置 missing，标签关联一并清除。

    原子性依赖调用方将本函数放在同一个 get_conn() 事务块内执行——
    全部写操作同事务提交/回滚，不存在「块已删而绑定仍 active」的中间态。
    标签联结行删除后，无存活块引用的标签由调用方 prune（tags.prune_orphan_tags）。
    目标不存在或已删时返回 False（幂等）。
    """
    now = utcnow()
    cur = conn.execute(
        "UPDATE blocks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        (now, now, block_id),
    )
    if cur.rowcount == 0:
        return False
    conn.execute(
        "UPDATE bindings SET status = 'missing', updated_at = ? "
        "WHERE block_id = ? AND status = 'active'",
        (now, block_id),
    )
    conn.execute("DELETE FROM block_tags WHERE block_id = ?", (block_id,))
    return True
