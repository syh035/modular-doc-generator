"""API 入口：/api/templates（上传 / 列表 / 详情 / 区域列表 / 预览 PDF）。"""

import json
import sqlite3
from typing import Annotated

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from app.core.config import settings
from app.core.errors import TEMPLATE_NOT_FOUND, AppError
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services import render_service, template_service
from app.services.libreoffice import cache_access
from app.services.review_summary import unsupported_objects

router = APIRouter(prefix="/api")


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: int) -> Response:
    template_service.delete_template(template_id)
    return Response(status_code=204)


def region_dict(r: Region) -> dict[str, object]:
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
        out["regions"] = [region_dict(r) for r in regions]
    if regions_count is not None:
        out["regions_count"] = regions_count
    return out


def _get_or_404(conn: sqlite3.Connection, template_id: int) -> Template:
    tpl = templates_repo.get_template(conn, template_id)
    if tpl is None:
        raise AppError(TEMPLATE_NOT_FOUND, f"模板不存在（id={template_id}）", status_code=404)
    return tpl


@router.post("/templates")
def upload_template(
    file: Annotated[UploadFile, File()],
    create_default_version: Annotated[bool, Form()] = True,
) -> JSONResponse:
    """上传 DOCX 模板；create_default_version=false 仅保存模板，旧调用默认建稿。

    201 = 新建；200 = 同 sha256 内容重传关联已有模板（D10，reused=true，
    区域与版本均为已有模板的解析结果）。同步完成（D12）。
    """
    data = file.file.read()
    tpl, regions, reused = template_service.upload_template(
        file.filename or "", data, create_default_version=create_default_version
    )
    out = _template_dict(tpl, regions=regions)
    out["default_version_id"] = _default_version_id(tpl.id)
    out["reused"] = reused
    return JSONResponse(status_code=200 if reused else 201, content=out)


def _default_version_id(template_id: int) -> int | None:
    """最早创建的版本 id；零文稿模板合法，返回 None，不自动补建。"""
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


@router.get("/templates/{template_id}/review-summary")
def review_summary(template_id: int) -> dict[str, object]:
    with get_conn() as conn:
        tpl = _get_or_404(conn, template_id)
        regions = regions_repo.list_regions(conn, template_id)
    return {
        "pending": sum(r.review_status == "pending" for r in regions),
        "confirmed": sum(r.review_status == "confirmed" for r in regions),
        "excluded": sum(r.review_status == "excluded" for r in regions),
        "unlocated": sum(r.bbox_json is None for r in regions),
        "unsupported": unsupported_objects(
            (settings.templates_dir / tpl.storage_name).read_bytes()
        ),
    }


@router.get("/templates/{template_id}/regions")
def list_regions(template_id: int) -> dict[str, object]:
    """模板全部区域，按文档流顺序（AGENTS.md 约定路径）。"""
    with get_conn() as conn:
        tpl = _get_or_404(conn, template_id)
        return {
            "template_id": tpl.id,
            "regions": [region_dict(r) for r in regions_repo.list_regions(conn, tpl.id)],
        }


@router.get("/templates/{template_id}/preview")
def get_preview(template_id: int) -> Response:
    """模板预览 PDF（单管线铁律：预览即管线产物，P2）。

    首次调用触发 LibreOffice 转换并计算区域 bbox（同步完成，10 页内
    模板远低于 D12 解析基线的量级）；后续调用命中转换缓存。
    """
    with cache_access():
        pdf_data = render_service.ensure_template_preview(template_id).read_bytes()
    # no-store：同 P25（URL 不随内容变化，禁止浏览器启发式缓存复用旧 PDF）
    return Response(pdf_data, media_type="application/pdf", headers={"Cache-Control": "no-store"})
