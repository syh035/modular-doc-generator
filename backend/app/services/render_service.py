"""渲染编排（M4）：模板 → PDF（缓存）→ 坐标提取 → 区域 bbox 落库。

预览与导出共用同一条「DOCX 生成 → LibreOffice → PDF」管线（单管线
铁律，P2）：本模块产出管线 PDF；导出（M9）复用同一 manager 与缓存。

- PDF 生成走 LibreOfficeManager 转换缓存：未变内容零开销重复预览
- bbox 只在首次渲染时计算落库（模板文件内容不变 → sha 不变 → 缓存
  命中；重新解析出的区域 bbox 由 M5b 校对流程另行维护）
- 单用户场景：全局渲染锁串行化，避免并发重复转换与重复落库
"""

import json
import threading
from pathlib import Path

from app.core.config import settings
from app.core.errors import RENDER_FAILED, TEMPLATE_NOT_FOUND, AppError
from app.models.db import get_conn
from app.models.entities import Region, Template
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.services import libreoffice
from app.services.docx_parser import iter_flow_paragraphs
from app.services.pdf_geometry import align_flow_to_lines, extract_pdf_lines

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


def _persist_region_bboxes(tpl: Template, regions: list[Region], pdf_path: Path) -> int:
    """对齐文档流与 PDF 行，落库各区域 bbox；返回成功落库的区域数。"""
    docx_path = settings.templates_dir / tpl.storage_name
    flow = list(iter_flow_paragraphs(docx_path.read_bytes()))
    geometry = align_flow_to_lines(flow, extract_pdf_lines(pdf_path))
    updated = 0
    with get_conn() as conn:
        for r in regions:
            if r.bbox_json:  # 已有坐标（如 M5b 校对产物）不覆盖
                continue
            anchor = json.loads(r.anchor)
            path = anchor["path"]
            assert isinstance(path, list)
            geo = geometry.get(tuple(path))
            if geo is None:
                continue  # 未匹配区域保持 bbox=None，M5b 人工兜底
            regions_repo.update_region(
                conn, r.id, bbox=_bbox_dict(geo.bbox, geo.page)
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
        if any(r.bbox_json is None for r in regions):
            _persist_region_bboxes(tpl, regions, pdf_path)
    return pdf_path
