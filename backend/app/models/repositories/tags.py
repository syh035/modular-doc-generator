"""tags / block_tags 表数据访问。

标签通过联结表按 id 关联块：rename 就地改 tags.name，全库引用自动生效；
merge（合并到已有标签）属 M2 service 层，此处不实现。
"""

import sqlite3

from app.models.db import utcnow
from app.models.entities import Tag

_TAG_SELECT = "SELECT id, name, created_at FROM tags"


def create_tag(conn: sqlite3.Connection, name: str) -> Tag:
    """新建标签；重名抛 sqlite3.IntegrityError（由调用方转业务错误）。"""
    cur = conn.execute("INSERT INTO tags (name, created_at) VALUES (?, ?)", (name, utcnow()))
    assert cur.lastrowid is not None
    tag = get_tag(conn, cur.lastrowid)
    assert tag is not None
    return tag


def get_tag(conn: sqlite3.Connection, tag_id: int) -> Tag | None:
    row = conn.execute(f"{_TAG_SELECT} WHERE id = ?", (tag_id,)).fetchone()
    return Tag.from_row(row) if row else None


def get_tag_by_name(conn: sqlite3.Connection, name: str) -> Tag | None:
    row = conn.execute(f"{_TAG_SELECT} WHERE name = ?", (name,)).fetchone()
    return Tag.from_row(row) if row else None


def list_tags(conn: sqlite3.Connection) -> list[Tag]:
    """全部标签（按名称排序，供筛选侧栏）。"""
    rows = conn.execute(f"{_TAG_SELECT} ORDER BY name").fetchall()
    return [Tag.from_row(r) for r in rows]


def rename_tag(conn: sqlite3.Connection, tag_id: int, new_name: str) -> Tag | None:
    """就地重命名——联结表存 id，全库引用自动生效（M2「重命名全库生效」的地基）。

    新名与已有标签撞名抛 sqlite3.IntegrityError（UNIQUE 约束）。
    """
    cur = conn.execute("UPDATE tags SET name = ? WHERE id = ?", (new_name, tag_id))
    if cur.rowcount == 0:
        return None
    tag = get_tag(conn, tag_id)
    assert tag is not None
    return tag


def delete_tag(conn: sqlite3.Connection, tag_id: int) -> bool:
    """物理删除标签（联结行 CASCADE 级联清理）。"""
    cur = conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    return cur.rowcount > 0


# ---- block_tags 联结操作 ----


def attach_tag(conn: sqlite3.Connection, block_id: int, tag_id: int) -> None:
    """给块挂标签（幂等：重复挂不报错、不产生重复行）。"""
    conn.execute(
        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        (block_id, tag_id),
    )


def detach_tag(conn: sqlite3.Connection, block_id: int, tag_id: int) -> None:
    """摘除块上的标签（不存在时静默无操作）。"""
    conn.execute("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?", (block_id, tag_id))


def tags_of_block(conn: sqlite3.Connection, block_id: int) -> list[Tag]:
    """块的全部标签（按名称排序）。"""
    rows = conn.execute(
        "SELECT t.id, t.name, t.created_at FROM tags t "
        "JOIN block_tags bt ON bt.tag_id = t.id "
        "WHERE bt.block_id = ? ORDER BY t.name",
        (block_id,),
    ).fetchall()
    return [Tag.from_row(r) for r in rows]
