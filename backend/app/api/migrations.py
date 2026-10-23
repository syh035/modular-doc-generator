"""API 入口：/api/templates/{id}/migrate/*（换模板迁移，M10，PRD 4.7 / D7）。

旧模式保持三清单与默认空稿；new_document 模式只读计划、确认后原子建新稿。
匹配规则见 migration_service，新稿的快照与重试契约见 document_migration。
"""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.models.db import get_conn
from app.services import document_migration, migration_service

router = APIRouter(prefix="/api")


class MigrationPlanRequest(BaseModel):
    source_version_id: int
    mode: Literal["legacy", "new_document"] = "legacy"


class MigrationPair(BaseModel):
    region_id: int
    block_id: int
    line_break_mode: Literal["paragraph", "soft"] = "paragraph"
    position: Literal["inside", "before", "after"] = "inside"


class DocumentPlacement(BaseModel):
    source_region_id: int
    target_region_id: int


class MigrationApplyRequest(BaseModel):
    source_version_id: int
    bindings: list[MigrationPair] = Field(default_factory=list)  # 可全留空（③可跳过）
    mode: Literal["legacy", "new_document"] = "legacy"
    name: str = ""
    plan_token: str = ""
    idempotency_key: str = ""
    placements: list[DocumentPlacement] = Field(default_factory=list)
    omitted_source_region_ids: list[int] = Field(default_factory=list)


@router.post("/templates/{template_id}/migrate/plan")
def plan_migration(template_id: int, payload: MigrationPlanRequest) -> dict[str, object]:
    """只读计算方案；新稿模式另返回正文与有效性令牌，不创建目标版本。"""
    with get_conn() as conn:
        if payload.mode == "new_document":
            conn.execute("BEGIN")
            return document_migration.build_plan(conn, payload.source_version_id, template_id)
        return migration_service.build_plan(conn, payload.source_version_id, template_id)


@router.post("/templates/{template_id}/migrate/apply", status_code=201)
def apply_migration(template_id: int, payload: MigrationApplyRequest) -> dict[str, object]:
    """旧模式写入默认空稿；新稿模式校验全部文字安排并原子创建。"""
    pairs = [(p.region_id, p.block_id) for p in payload.bindings]
    with get_conn() as conn:
        if payload.mode == "new_document":
            return document_migration.apply_new_document(
                conn,
                payload.source_version_id,
                template_id,
                name=payload.name,
                plan_token=payload.plan_token,
                idempotency_key=payload.idempotency_key,
                placements=[(p.source_region_id, p.target_region_id) for p in payload.placements],
                omitted=payload.omitted_source_region_ids,
            )
        return migration_service.apply_migration(
            conn,
            payload.source_version_id,
            template_id,
            pairs,
            settings_by_region={
                p.region_id: (p.line_break_mode, p.position) for p in payload.bindings
            },
        )
