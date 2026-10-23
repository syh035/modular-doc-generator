"""显式生成新文稿：计划只读，提交核对快照并在同一事务创建文稿、绑定及回执。"""

import hashlib
import json
import sqlite3
from typing import Any

from app.core.errors import (
    MIGRATION_INVALID,
    MIGRATION_PLAN_STALE,
    MIGRATION_REQUEST_CONFLICT,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.db import utcnow
from app.models.repositories import bindings, regions, versions
from app.services import migration_service, version_service


def _hash(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def build_plan(conn: sqlite3.Connection, source_id: int, target_id: int) -> dict[str, Any]:
    plan = migration_service.build_plan(conn, source_id, target_id, new_document=True)
    source = migration_service.new_source_items(conn, source_id)
    # 自动几何和更新时间不参与语义快照，后续试排不能使自己的计划失效。
    target_regions = [
        {
            "manual_bbox": r.bbox_json if r.bbox_source == "manual" else None,
            **{
                key: getattr(r, key)
                for key in (
                    "id",
                    "type",
                    "label",
                    "placeholder",
                    "anchor",
                    "order_index",
                    "review_status",
                )
            },
        }
        for r in regions.list_regions(conn, target_id)
    ]
    templates = [
        dict(row)
        for row in conn.execute(
            "SELECT id, sha256, storage_name FROM templates WHERE id IN (?, ?) ORDER BY id",
            (plan["source_template_id"], target_id),
        )
    ]
    token = _hash(
        {
            "revision": 1,
            "plan": plan,
            "source": source,
            "regions": target_regions,
            "templates": templates,
        }
    )
    return {**plan, "mode": "new_document", "source_items": source, "plan_token": token}


def _invalid(message: str) -> None:
    raise AppError(MIGRATION_INVALID, message, status_code=400)


def apply_new_document(
    conn: sqlite3.Connection,
    source_id: int,
    target_id: int,
    *,
    name: str,
    plan_token: str,
    idempotency_key: str,
    placements: list[tuple[int, int]],
    omitted: list[int],
) -> dict[str, Any]:
    name = name.strip()
    if not 1 <= len(name) <= 30:
        _invalid("新文稿名称须为 1–30 字")
    if not 1 <= len(idempotency_key) <= 100 or not plan_token:
        _invalid("缺少有效的提交标识或计划，请重新查看套用效果")
    request_hash = _hash(
        {
            "source": source_id,
            "target": target_id,
            "name": name,
            "token": plan_token,
            "placements": sorted(placements),
            "omitted": sorted(omitted),
        }
    )
    # 在检查与创建之前取得写锁，两个并发重试只能产生一份文稿。
    conn.execute("BEGIN IMMEDIATE")
    receipt = conn.execute(
        "SELECT request_sha256, response_json FROM migration_receipts WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()
    if receipt is not None:
        if receipt[0] != request_hash:
            raise AppError(
                MIGRATION_REQUEST_CONFLICT,
                "此提交标识已用于不同操作，请重新提交",
                status_code=409,
            )
        result = json.loads(receipt[1])
        if versions.get_version(conn, result["version_id"]) is None:
            raise AppError(
                VERSION_NOT_FOUND, "此前生成的文稿已删除，重试不会再次创建", status_code=410
            )
        return dict(result)
    plan = build_plan(conn, source_id, target_id)
    if plan["plan_token"] != plan_token:
        raise AppError(
            MIGRATION_PLAN_STALE, "原稿文字或模板已变化，请重新查看套用效果", status_code=409
        )
    source = {int(item["source_region_id"]): item for item in plan["source_items"]}
    target = {r.id for r in regions.list_regions(conn, target_id) if r.review_status != "excluded"}
    placed_sources = [s for s, _ in placements]
    placed_targets = [t for _, t in placements]
    if len(set(placed_sources)) != len(placed_sources) or len(set(placed_targets)) != len(
        placed_targets
    ):
        _invalid("每段文字只能放置一次，每个位置也只能使用一次")
    if len(set(omitted)) != len(omitted) or set(placed_sources) & set(omitted):
        _invalid("同一段文字不能同时放置和不带入")
    if set(placed_sources) | set(omitted) != set(source):
        _invalid("请为每段文字选择位置，或明确选择本次不带入")
    if not set(placed_targets) <= target:
        _invalid("所选位置已不存在、已排除或不属于新模板")
    document = version_service.create_version(conn, target_id, name)
    for source_region_id, target_region_id in placements:
        item = source[source_region_id]
        bindings.upsert_binding(
            conn,
            document.id,
            target_region_id,
            int(item["block_id"]),
            line_break_mode=str(item["line_break_mode"]),
            position=str(item["position"]),
        )
    result = {
        "version_id": document.id,
        "created": len(placements),
        "template_id": target_id,
        "name": document.name,
    }
    conn.execute(
        "INSERT INTO migration_receipts VALUES (?, ?, ?, ?)",
        (idempotency_key, request_hash, json.dumps(result), utcnow()),
    )
    return result
