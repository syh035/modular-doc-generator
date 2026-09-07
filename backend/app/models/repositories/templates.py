"""templates 表数据访问。

sha256 为内容指纹（D10 重传关联地基）：同内容重传 → find_by_sha256 命中已有记录；
状态机流转由 M3 的 service 层驱动，此处只提供带枚举校验的更新原语。
"""

import sqlite3

from app.core.constants import TEMPLATE_STATUSES
from app.models.db import utcnow
from app.models.entities import Template

_SELECT = "SELECT id, filename, storage_name, sha256, status, created_at, updated_at FROM templates"


def create_template(
    conn: sqlite3.Connection, filename: str, storage_name: str, sha256: str, status: str = "parsing"
) -> Template:
    """新建模板记录（落盘文件由 M3 的 service 层写，storage_name 先登记）。"""
    if status not in TEMPLATE_STATUSES:
        raise ValueError(f"非法模板状态: {status!r}，合法值 {sorted(TEMPLATE_STATUSES)}")
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO templates (filename, storage_name, sha256, status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (filename, storage_name, sha256, status, now, now),
    )
    assert cur.lastrowid is not None
    tpl = get_template(conn, cur.lastrowid)
    assert tpl is not None
    return tpl


def get_template(conn: sqlite3.Connection, template_id: int) -> Template | None:
    row = conn.execute(f"{_SELECT} WHERE id = ?", (template_id,)).fetchone()
    return Template.from_row(row) if row else None


def list_templates(conn: sqlite3.Connection) -> list[Template]:
    rows = conn.execute(f"{_SELECT} ORDER BY id DESC").fetchall()  # 最新上传在前
    return [Template.from_row(r) for r in rows]


def find_by_sha256(conn: sqlite3.Connection, sha256: str) -> Template | None:
    """按内容指纹查模板（D10：重传同内容文件时关联既有记录）。"""
    row = conn.execute(f"{_SELECT} WHERE sha256 = ?", (sha256,)).fetchone()
    return Template.from_row(row) if row else None


def update_template(
    conn: sqlite3.Connection,
    template_id: int,
    *,
    filename: str | None = None,
    storage_name: str | None = None,
    status: str | None = None,
) -> Template | None:
    """部分更新；status 做枚举校验（应用层守门，schema 不设 CHECK）。"""
    if status is not None and status not in TEMPLATE_STATUSES:
        raise ValueError(f"非法模板状态: {status!r}，合法值 {sorted(TEMPLATE_STATUSES)}")
    sets: list[str] = []
    params: list[object] = []
    if filename is not None:
        sets.append("filename = ?")
        params.append(filename)
    if storage_name is not None:
        sets.append("storage_name = ?")
        params.append(storage_name)
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if not sets:
        return get_template(conn, template_id)
    sets.append("updated_at = ?")
    params.append(utcnow())
    params.append(template_id)
    cur = conn.execute(f"UPDATE templates SET {', '.join(sets)} WHERE id = ?", params)
    if cur.rowcount == 0:
        return None
    tpl = get_template(conn, template_id)
    assert tpl is not None
    return tpl
