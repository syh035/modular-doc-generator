"""regions 表数据访问。

anchor / bbox 接收 dict、以 JSON 文本落库（P3：身份锚定文档流元素，
bbox 仅展示与测量）；读回时实体保留 JSON 字符串，结构化解析归 service 层。
"""

import json
import sqlite3
from typing import Any

from app.core.constants import REGION_REVIEW_STATUSES, REGION_TYPES
from app.models.db import utcnow
from app.models.entities import Region

_SELECT = (
    "SELECT id, template_id, type, label, placeholder, anchor, order_index, "
    "bbox_json, confidence, review_status, created_at, updated_at FROM regions"
)


def create_region(
    conn: sqlite3.Connection,
    template_id: int,
    *,
    region_type: str,
    label: str,
    anchor: dict[str, Any],
    order_index: int,
    placeholder: str | None = None,
    bbox: dict[str, Any] | None = None,
    confidence: float | None = None,
    review_status: str = "pending",
) -> Region:
    """新建可替换区域。anchor 必填（区域身份锚点，P3）。"""
    if region_type not in REGION_TYPES:
        raise ValueError(f"非法区域类型: {region_type!r}，合法值 {sorted(REGION_TYPES)}")
    if review_status not in REGION_REVIEW_STATUSES:
        raise ValueError(
            f"非法校对状态: {review_status!r}，合法值 {sorted(REGION_REVIEW_STATUSES)}"
        )
    now = utcnow()
    cur = conn.execute(
        "INSERT INTO regions (template_id, type, label, placeholder, anchor, order_index, "
        "bbox_json, confidence, review_status, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            template_id,
            region_type,
            label,
            placeholder,
            json.dumps(anchor, ensure_ascii=False),
            order_index,
            json.dumps(bbox, ensure_ascii=False) if bbox is not None else None,
            confidence,
            review_status,
            now,
            now,
        ),
    )
    assert cur.lastrowid is not None
    region = get_region(conn, cur.lastrowid)
    assert region is not None
    return region


def get_region(conn: sqlite3.Connection, region_id: int) -> Region | None:
    row = conn.execute(f"{_SELECT} WHERE id = ?", (region_id,)).fetchone()
    return Region.from_row(row) if row else None


def list_regions(conn: sqlite3.Connection, template_id: int) -> list[Region]:
    """模板全部区域，按文档流顺序返回（D7 迁移匹配依据）。"""
    rows = conn.execute(
        f"{_SELECT} WHERE template_id = ? ORDER BY order_index", (template_id,)
    ).fetchall()
    return [Region.from_row(r) for r in rows]


def count_regions(conn: sqlite3.Connection, template_id: int) -> int:
    """模板区域数（列表页摘要用，免整行加载）。"""
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM regions WHERE template_id = ?", (template_id,)
    ).fetchone()
    return int(row["n"])


def update_region(
    conn: sqlite3.Connection,
    region_id: int,
    *,
    region_type: str | None = None,
    label: str | None = None,
    placeholder: str | None = None,
    anchor: dict[str, Any] | None = None,
    order_index: int | None = None,
    bbox: dict[str, Any] | None = None,
    confidence: float | None = None,
    review_status: str | None = None,
) -> Region | None:
    """部分更新（仅传入的字段）。bbox 传 None 表示「不更新」；置空坐标请传空 dict。"""
    if region_type is not None and region_type not in REGION_TYPES:
        raise ValueError(f"非法区域类型: {region_type!r}，合法值 {sorted(REGION_TYPES)}")
    if review_status is not None and review_status not in REGION_REVIEW_STATUSES:
        raise ValueError(
            f"非法校对状态: {review_status!r}，合法值 {sorted(REGION_REVIEW_STATUSES)}"
        )
    sets: list[str] = []
    params: list[object] = []
    if region_type is not None:
        sets.append("type = ?")
        params.append(region_type)
    if label is not None:
        sets.append("label = ?")
        params.append(label)
    if placeholder is not None:
        sets.append("placeholder = ?")
        params.append(placeholder)
    if anchor is not None:
        sets.append("anchor = ?")
        params.append(json.dumps(anchor, ensure_ascii=False))
    if order_index is not None:
        sets.append("order_index = ?")
        params.append(order_index)
    if bbox is not None:
        sets.append("bbox_json = ?")
        params.append(json.dumps(bbox, ensure_ascii=False))
    if confidence is not None:
        sets.append("confidence = ?")
        params.append(confidence)
    if review_status is not None:
        sets.append("review_status = ?")
        params.append(review_status)
    if not sets:
        return get_region(conn, region_id)
    sets.append("updated_at = ?")
    params.append(utcnow())
    params.append(region_id)
    cur = conn.execute(f"UPDATE regions SET {', '.join(sets)} WHERE id = ?", params)
    if cur.rowcount == 0:
        return None
    region = get_region(conn, region_id)
    assert region is not None
    return region


def delete_region(conn: sqlite3.Connection, region_id: int) -> bool:
    """物理删除区域；其下绑定经 FK CASCADE 一并删除（区域没了绑定无意义）。"""
    cur = conn.execute("DELETE FROM regions WHERE id = ?", (region_id,))
    return cur.rowcount > 0
