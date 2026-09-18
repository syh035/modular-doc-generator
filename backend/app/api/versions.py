"""API 入口：/api/versions（版本绑定 CRUD + 版本渲染，M6a）。

绑定规则（PRD 4.4 / D11）：
- 一区域一版本只绑一块（UNIQUE(version_id, region_id)，upsert 换绑）
- 区域必须属于该版本所属模板；块必须存活
- 块软删除 → 绑定原子置 missing（blocks repo 同事务完成），本层不重复
"""

from fastapi import APIRouter, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core.errors import (
    BINDING_NOT_FOUND,
    BLOCK_NOT_FOUND,
    REGION_NOT_FOUND,
    REGION_TEMPLATE_MISMATCH,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Binding
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import regions as regions_repo
from app.models.repositories import versions as versions_repo
from app.services import render_service

router = APIRouter(prefix="/api")


def _binding_dict(b: Binding, block_name: str | None) -> dict[str, object]:
    return {
        "version_id": b.version_id,
        "region_id": b.region_id,
        "block_id": b.block_id,
        "block_name": block_name,
        "status": b.status,
        "created_at": b.created_at,
        "updated_at": b.updated_at,
    }


class BindingCreate(BaseModel):
    region_id: int
    block_id: int


@router.post("/versions/{version_id}/bindings")
def upsert_binding(version_id: int, payload: BindingCreate) -> dict[str, object]:
    """绑定/换绑（同版本同区域覆盖旧块，幂等语义统一 200）。"""
    with get_conn() as conn:
        version = versions_repo.get_version(conn, version_id)
        if version is None:
            raise AppError(
                VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404
            )
        region = regions_repo.get_region(conn, payload.region_id)
        if region is None:
            raise AppError(
                REGION_NOT_FOUND, f"区域不存在（id={payload.region_id}）", status_code=404
            )
        if region.template_id != version.template_id:
            raise AppError(
                REGION_TEMPLATE_MISMATCH,
                f"区域（id={region.id}）不属于该版本所属模板（id={version.template_id}）",
                status_code=400,
            )
        block = blocks_repo.get_block(conn, payload.block_id)
        if block is None:
            raise AppError(
                BLOCK_NOT_FOUND,
                f"字符块不存在或已删除（id={payload.block_id}）",
                status_code=404,
            )
        binding = bindings_repo.upsert_binding(
            conn, version_id, payload.region_id, payload.block_id
        )
    return _binding_dict(binding, block.name)


@router.get("/versions/{version_id}/bindings")
def list_bindings(version_id: int) -> dict[str, object]:
    """版本绑定列表（含 missing 态，调试/校对呈现用）。"""
    with get_conn() as conn:
        version = versions_repo.get_version(conn, version_id)
        if version is None:
            raise AppError(
                VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404
            )
        items = []
        for b in bindings_repo.list_bindings(conn, version_id):
            block = blocks_repo.get_block(conn, b.block_id, include_deleted=True)
            items.append(_binding_dict(b, block.name if block else None))
    return {"bindings": items}


@router.delete("/versions/{version_id}/bindings/{region_id}", status_code=204)
def delete_binding(version_id: int, region_id: int) -> Response:
    """解绑；绑定不存在 → 404。"""
    with get_conn() as conn:
        if versions_repo.get_version(conn, version_id) is None:
            raise AppError(
                VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404
            )
        existing = bindings_repo.get_binding(conn, version_id, region_id)
        if existing is None:
            raise AppError(
                BINDING_NOT_FOUND,
                f"该区域未绑定（version={version_id}, region={region_id}）",
                status_code=404,
            )
        deleted = bindings_repo.delete_binding(conn, existing.id)
        assert deleted
    return Response(status_code=204)


@router.get("/versions/{version_id}/preview")
def get_version_preview(version_id: int) -> FileResponse:
    """版本预览 PDF（模板 + 绑定替换后的成品，单管线铁律）。

    Cache-Control: no-store——URL 不随绑定内容变化，若交给浏览器启发式缓存，
    绑定后会复用旧 PDF 导致「替换了但预览没反应」（2026-09-18 实锤，P25）；
    转换成本由后端内容寻址缓存兜底，浏览器禁止缓存。
    """
    rendered = render_service.render_version(version_id)
    return FileResponse(
        rendered.pdf_path, media_type="application/pdf", headers={"Cache-Control": "no-store"}
    )


@router.get("/versions/{version_id}/overlay")
def get_version_overlay(version_id: int) -> dict[str, object]:
    """版本覆盖层：区域 × 替换后 bbox（随渲染产物现算，不落库）× 绑定态。"""
    rendered = render_service.render_version(version_id)
    return {
        "version_id": version_id,
        "regions": rendered.items,
    }
