"""API 入口：/api/templates/{id}/migrate/*（换模板迁移，M10，PRD 4.7 / D7）。

两段式：plan 纯计算返回三清单（前端确认界面数据源）→ apply 整包落库最终映射。
匹配规则与守门见 services/migration_service.py 模块注释。
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.models.db import get_conn
from app.services import migration_service

router = APIRouter(prefix="/api")


class MigrationPlanRequest(BaseModel):
    source_version_id: int


class MigrationPair(BaseModel):
    region_id: int
    block_id: int


class MigrationApplyRequest(BaseModel):
    source_version_id: int
    bindings: list[MigrationPair] = Field(default_factory=list)  # 可全留空（③可跳过）


@router.post("/templates/{template_id}/migrate/plan")
def plan_migration(template_id: int, payload: MigrationPlanRequest) -> dict[str, object]:
    """计算迁移方案：auto/candidates/unmatched 三清单（纯计算，不落库）。"""
    with get_conn() as conn:
        return migration_service.build_plan(conn, payload.source_version_id, template_id)


@router.post("/templates/{template_id}/migrate/apply", status_code=201)
def apply_migration(template_id: int, payload: MigrationApplyRequest) -> dict[str, object]:
    """落库最终映射（目标默认版本须空白）；返回 {version_id, created}。"""
    pairs = [(p.region_id, p.block_id) for p in payload.bindings]
    with get_conn() as conn:
        return migration_service.apply_migration(
            conn, payload.source_version_id, template_id, pairs
        )
