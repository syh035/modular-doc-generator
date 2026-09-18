"""渲染编排（M4/M6a）：模板 → PDF（缓存）→ 坐标提取 → 区域 bbox。

预览与导出共用同一条「DOCX 生成 → LibreOffice → PDF」管线（单管线
铁律，P2）：本模块产出管线 PDF；导出（M9）复用同一 manager 与缓存。

- PDF 生成走 LibreOfficeManager 转换缓存：未变内容零开销重复预览
- 模板 bbox 只在首次渲染时计算落库（模板文件内容不变 → sha 不变 →
  缓存命中；重新解析出的区域 bbox 由 M5b 校对流程另行维护）
- 版本渲染（M6a）：模板 + 版本绑定 → 替换引擎产出成品 DOCX →
  同一 LO 管线转 PDF → 几何对齐得替换后 bbox（随响应返回、不落库，
  规避 P21 陈旧 bbox；缓存键 = 成品内容 sha，同组合重复预览秒开）
- 单用户场景：全局渲染锁串行化，避免并发重复转换与重复落库
"""

import hashlib
import json
import threading
import uuid
from pathlib import Path

from app.core.config import settings
from app.core.errors import (
    RENDER_FAILED,
    TEMPLATE_NOT_FOUND,
    VERSION_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Block, Region, Template
from app.models.repositories import bindings as bindings_repo
from app.models.repositories import blocks as blocks_repo
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.models.repositories import versions as versions_repo
from app.services import libreoffice
from app.services.docx_parser import iter_flow_paragraphs
from app.services.pdf_geometry import RegionGeometry, align_flow_to_lines, extract_pdf_lines
from app.services.replacement import apply_replacements

_render_lock = threading.Lock()


def _bbox_dict(geo_bbox: tuple[float, float, float, float], page: int) -> dict[str, object]:
    """regions.bbox 落库结构：PDF 点、原点左上、页码 0 基（M5a 前端契约）。"""
    x0, y0, x1, y1 = geo_bbox
    return {
        "page": page,
        "x0": round(x0, 2),
        "y0": round(y0, 2),
        "x1": round(x1, 2),
        "y1": round(y1, 2),
    }


def pdf_sha256(pdf_path: Path) -> str:
    """渲染产物 PDF 内容 sha256（P21 bbox 生命周期：bbox 记录测量来源）。"""
    return hashlib.sha256(pdf_path.read_bytes()).hexdigest()


def _persist_region_bboxes(
    tpl: Template, regions: list[Region], pdf_path: Path, pdf_sha: str
) -> int:
    """对齐文档流与 PDF 行，落库各区域 bbox；返回成功落库的区域数。

    P21 生命周期：auto bbox 在 bbox_pdf_sha ≠ 当前 PDF sha 时失效重算；
    manual（校对人工微调/框选）bbox 保护不覆盖。
    """
    docx_path = settings.templates_dir / tpl.storage_name
    flow = list(iter_flow_paragraphs(docx_path.read_bytes()))
    geometry = align_flow_to_lines(flow, extract_pdf_lines(pdf_path))
    updated = 0
    with get_conn() as conn:
        for r in regions:
            stale = r.bbox_json is None or (
                r.bbox_source != "manual" and r.bbox_pdf_sha != pdf_sha
            )
            if not stale:
                continue
            anchor = json.loads(r.anchor)
            path = anchor["path"]
            assert isinstance(path, list)
            geo = geometry.get(tuple(path))
            if geo is None:
                continue  # 未匹配区域保持 bbox=None，M5b 人工兜底
            regions_repo.update_region(
                conn,
                r.id,
                bbox=_bbox_dict(geo.bbox, geo.page),
                bbox_source="auto",
                bbox_pdf_sha=pdf_sha,
            )
            updated += 1
    return updated


def ensure_template_preview(template_id: int) -> Path:
    """确保模板渲染产物就绪，返回管线 PDF 路径（供 FileResponse 直出）。

    幂等：首次调用执行转换与 bbox 计算，后续调用命中缓存直接返回。
    模板不存在 → 404；soffice 缺失 → 503；转换失败/超时 → RENDER_*。
    """
    with get_conn() as conn:
        tpl = templates_repo.get_template(conn, template_id)
        if tpl is None:
            raise AppError(
                TEMPLATE_NOT_FOUND, f"模板不存在（id={template_id}）", status_code=404
            )
        regions = regions_repo.list_regions(conn, tpl.id)
    docx_path = settings.templates_dir / tpl.storage_name
    if not docx_path.is_file():
        raise AppError(
            RENDER_FAILED,
            f"模板文件缺失（{tpl.storage_name}），请重新上传模板",
            status_code=500,
        )
    with _render_lock:
        pdf_path = libreoffice.get_manager().convert(docx_path)
        pdf_sha = pdf_sha256(pdf_path)
        # P21：auto bbox 随渲染产物变化失效重算（manual 校对产物保护不覆盖）
        if any(
            r.bbox_json is None or (r.bbox_source != "manual" and r.bbox_pdf_sha != pdf_sha)
            for r in regions
        ):
            _persist_region_bboxes(tpl, regions, pdf_path, pdf_sha)
    return pdf_path


class VersionRender:
    """版本渲染产物：成品 PDF 路径 + 覆盖层数据（区域 × 替换后 bbox × 绑定态）。"""

    def __init__(self, pdf_path: Path, items: list[dict[str, object]]) -> None:
        self.pdf_path = pdf_path
        self.items = items


def render_version(version_id: int) -> VersionRender:
    """渲染内容版本：替换 → LO 转 PDF（sha 缓存）→ 几何对齐。

    每次现算替换与对齐（毫秒级），重开销全部压在 LO 转换上、由内容
    sha 缓存吸收。替换后 bbox 不落库（P21：随渲染产物变化，入响应
    即走即弃）。版本不存在 → 404。
    """
    with get_conn() as conn:
        version = versions_repo.get_version(conn, version_id)
        if version is None:
            raise AppError(
                VERSION_NOT_FOUND, f"内容版本不存在（id={version_id}）", status_code=404
            )
        tpl = templates_repo.get_template(conn, version.template_id)
        if tpl is None:
            raise AppError(
                TEMPLATE_NOT_FOUND,
                f"版本所属模板不存在（id={version.template_id}）",
                status_code=404,
            )
        regions = regions_repo.list_regions(conn, tpl.id)
        bindings = bindings_repo.list_bindings(conn, version.id)
        # 有效绑定（active 且块存活）→ 替换内容；missing 态保留原文
        block_by_id: dict[int, Block] = {}
        block_contents: dict[int, str] = {}
        for b in bindings:
            block = blocks_repo.get_block(conn, b.block_id)
            if block is None:
                continue  # 块已物理删除（RESTRICT 兜底，理论不可达）
            block_by_id[b.block_id] = block
            if b.status == "active":
                block_contents[b.region_id] = block.content
        binding_by_region = {b.region_id: b for b in bindings}

    docx_path = settings.templates_dir / tpl.storage_name
    if not docx_path.is_file():
        raise AppError(
            RENDER_FAILED,
            f"模板文件缺失（{tpl.storage_name}），请重新上传模板",
            status_code=500,
        )

    outcome = apply_replacements(docx_path.read_bytes(), regions, block_contents)

    # 成品 DOCX 走 LO 缓存：临时文件（uuid 防并发碰撞）→ convert → 即删
    tmp_dir = settings.render_cache_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_docx = tmp_dir / f"v_{version_id}_{uuid.uuid4().hex}.docx"
    try:
        tmp_docx.write_bytes(outcome.data)
        pdf_path = libreoffice.get_manager().convert(tmp_docx)
    finally:
        tmp_docx.unlink(missing_ok=True)

    # 几何对齐：成品文档流 ↔ 成品 PDF；region_paths 给出首行段落新 path
    flow = list(iter_flow_paragraphs(outcome.data))
    geometry = align_flow_to_lines(flow, extract_pdf_lines(pdf_path))
    items: list[dict[str, object]] = []
    for region in regions:
        anchor = json.loads(region.anchor)
        path = anchor["path"]
        assert isinstance(path, list)
        new_path = outcome.region_paths.get(region.id)
        geo: RegionGeometry | None = geometry.get(tuple(new_path)) if new_path else None
        binding = binding_by_region.get(region.id)
        block = block_by_id.get(binding.block_id) if binding else None
        items.append(
            {
                "id": region.id,
                "template_id": region.template_id,
                "type": region.type,
                "label": region.label,
                "placeholder": region.placeholder,
                "anchor": anchor,
                "order_index": region.order_index,
                "bbox": _bbox_dict(geo.bbox, geo.page) if geo else None,
                "confidence": region.confidence,
                "review_status": region.review_status,
                "binding": (
                    {
                        "block_id": binding.block_id,
                        "block_name": block.name if block else None,
                        "status": binding.status,
                    }
                    if binding
                    else None
                ),
            }
        )
    return VersionRender(pdf_path, items)
