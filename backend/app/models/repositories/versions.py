"""versions 表数据访问。

版本归属模板，同模板内命名唯一（M8 删除保护等业务规则属 service 层，此处纯存储）。
"""

import sqlite3

from app.models.db import utcnow
from app.models.entities import Version

_SELECT = "SELECT id, template_id, name, created_at, updated_at FROM versions"


def create_version(conn: sqlite3.Connection, template_id: int, name: str) -> Version:
    """新建内容版本；同模板内重名抛 sqlite3.IntegrityError（UNIQUE 约束）。"""
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO versions (template_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (template_id, name, now, now),
    )
    assert cur.lastrowid is not None
    ver = get_version(conn, cur.lastrowid)
    assert ver is not None
    return ver


def get_version(conn: sqlite3.Connection, version_id: int) -> Version | None:
    row = conn.execute(f"{_SELECT} WHERE id = ?", (version_id,)).fetchone()
    return Version.from_row(row) if row else None


def list_versions(conn: sqlite3.Connection, template_id: int) -> list[Version]:
    """模板的版本列表（创建正序）。"""
    rows = conn.execute(
        f"{_SELECT} WHERE template_id = ? ORDER BY id", (template_id,)
    ).fetchall()
    return [Version.from_row(r) for r in rows]


def rename_version(conn: sqlite3.Connection, version_id: int, new_name: str) -> Version | None:
    """重命名；撞同模板内已有名抛 sqlite3.IntegrityError。"""
    cur = conn.execute("UPDATE versions SET name = ?, updated_at = ? WHERE id = ?",
                       (new_name, utcnow(), version_id))
    if cur.rowcount == 0:
        return None
    ver = get_version(conn, version_id)
    assert ver is not None
    return ver


def delete_version(conn: sqlite3.Connection, version_id: int) -> bool:
    """物理删除版本；其下绑定经 FK CASCADE 一并删除。删除保护（M8）由 service 层守门。"""
    cur = conn.execute("DELETE FROM versions WHERE id = ?", (version_id,))
    return cur.rowcount > 0
