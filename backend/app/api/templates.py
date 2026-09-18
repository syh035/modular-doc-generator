"""API 入口：/api/templates（上传 / 列表 / 详情 / 区域列表 / 预览 PDF）。"""

import json
import sqlite3
from typing import Annotated

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from app.core.errors import TEMPLATE_NOT_FOUND, AppError
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services import render_service, template_service

router = APIRouter(prefix="/api")


def _region_dict(r: Region) -> dict[str, object]:
    """区域序列化：anchor/bbox 落库为 JSON 文本，出参还原为对象。"""
    return {
        "id": r.id,
        "template_id": r.template_id,
        "type": r.type,
        "label": r.label,
        "placeholder": r.placeholder,
        "anchor": json.loads(r.anchor),
        "order_index": r.order_index,
        "bbox": json.loads(r.bbox_json) if r.bbox_json else None,
        "confidence": r.confidence,
        "review_status": r.review_status,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }


def _template_dict(
    t: Template, *, regions: list[Region] | None = None, regions_count: int | None = None
) -> dict[str, object]:
    out: dict[str, object] = {
        "id": t.id,
        "filename": t.filename,
        "storage_name": t.storage_name,
        "sha256": t.sha256,
        "status": t.status,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }
    if regions is not None:
        out["regions"] = [_region_dict(r) for r in regions]
    if regions_count is not None:
        out["regions_count"] = regions_count
    return out


def _get_or_404(conn: sqlite3.Connection, template_id: int) -> Template:
    tpl = templates_repo.get_template(conn, template_id)
    if tpl is None:
        raise AppError(TEMPLATE_NOT_FOUND, f"模板不存在（id={template_id}）", status_code=404)
    return tpl


@router.post("/templates")
def upload_template(file: Annotated[UploadFile, File()]) -> JSONResponse:
    """上传 DOCX 模板：校验 → 候选解析（M3b 三层识别）→ 默认版本。

    201 = 新建；200 = 同 sha256 内容重传关联已有模板（D10，reused=true，
    区域与版本均为已有模板的解析结果）。同步完成（D12）。
    """
    data = file.file.read()
    tpl, regions, reused = template_service.upload_template(file.filename or "", data)
    out = _template_dict(tpl, regions=regions)
    out["default_version_id"] = _default_version_id(tpl.id)
    out["reused"] = reused
    return JSONResponse(status_code=200 if reused else 201, content=out)


def _default_version_id(template_id: int) -> int | None:
    """模板默认版本 id（最早创建即默认；无版本=历史数据，前端走模板预览兜底）。"""
    with get_conn() as conn:
        versions = versions_repo.list_versions(conn, template_id)
    return versions[0].id if versions else None


@router.get("/templates")
def list_templates() -> dict[str, object]:
    """模板列表（最新上传在前），附区域数摘要。"""
    with get_conn() as conn:
        items = [
            _template_dict(t, regions_count=regions_repo.count_regions(conn, t.id))
            for t in templates_repo.list_templates(conn)
        ]
    return {"templates": items}


@router.get("/templates/{template_id}")
def get_template(template_id: int) -> dict[str, object]:
    """模板详情（含全部区域 + 默认版本 id）。"""
    with get_conn() as conn:
        tpl = _get_or_404(conn, template_id)
        out = _template_dict(tpl, regions=regions_repo.list_regions(conn, tpl.id))
    out["default_version_id"] = _default_version_id(tpl.id)
    return out


@router.get("/templates/{template_id}/regions")
def list_regions(template_id: int) -> dict[str, object]:
    """模板全部区域，按文档流顺序（AGENTS.md 约定路径）。"""
    with get_conn() as conn:
        tpl = _get_or_404(conn, template_id)
        return {
            "template_id": tpl.id,
            "regions": [_region_dict(r) for r in regions_repo.list_regions(conn, tpl.id)],
        }


@router.get("/templates/{template_id}/preview")
def get_preview(template_id: int) -> FileResponse:
    """模板预览 PDF（单管线铁律：预览即管线产物，P2）。

    首次调用触发 LibreOffice 转换并计算区域 bbox（同步完成，10 页内
    模板远低于 D12 解析基线的量级）；后续调用命中转换缓存。
    """
    pdf_path = render_service.ensure_template_preview(template_id)
    return FileResponse(pdf_path, media_type="application/pdf")
