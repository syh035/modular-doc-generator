"""校对服务（M5b，PRD 4.3）：候选确认/排除、框选新建、边界微调、删除。

框选新建的几何反解：用户在预览 PDF 上画矩形 → 服务端用管线 PDF 行几何
（align_flow_to_lines）把矩形映射回文档流段落 anchor（P3：区域身份锚定
文档流元素，bbox 仅展示与测量）。替换引擎（M6a）按 anchor 定位段落，
1 区域 = 1 锚点段落，因此框选覆盖多段 → 拦截提示逐段框选
（2026-09-18 用户确认 Q1）。

区域状态机（PRD 4.3 区域状态流转）：pending → confirmed/excluded；
confirmed/excluded → pending（重新校对）。每次校对操作逐笔落库
（中断续作）；「存在区域且无 pending」时模板自动转 ready
（PRD 4.2：全部区域处理完毕，2026-09-18 用户确认 Q3 自动触发）。
"""

from typing import Any

from app.core.config import settings
from app.core.errors import (
    REGION_FRAME_EMPTY,
    REGION_FRAME_MULTI,
    REGION_INVALID,
    REGION_NOT_FOUND,
    REGION_REVIEW_INVALID,
    RENDER_FAILED,
    TEMPLATE_NOT_FOUND,
    AppError,
)
from app.models.db import get_conn
from app.models.entities import Region
from app.models.repositories import regions as regions_repo
from app.models.repositories import templates as templates_repo
from app.services import render_service
from app.services.docx_parser import iter_flow_paragraphs
from app.services.pdf_geometry import RegionGeometry, align_flow_to_lines, extract_pdf_lines

# 允许的校对状态流转（同状态重复提交视为无变化，不校验）
_REVIEW_TRANSITIONS = {
    ("pending", "confirmed"),
    ("pending", "excluded"),
    ("confirmed", "pending"),
    ("excluded", "pending"),
}

# 命中判定：矩形与段落 bbox 交叠的宽、高均须 ≥ 此值（pt）——
# 滤掉拖拽掠过相邻段落边界的发丝级交叠，同时不误伤合法的小范围框选
_MIN_HIT_DIM = 2.0

_LABEL_MAX = 50  # 区域显示名上限（校对界面用，非块名 2–30 规则）


def _validate_frame(frame: dict[str, Any]) -> None:
    """bbox 结构校验：page 0 基非负、坐标有限且 x1>x0 / y1>y0（空/倒置框拦截）。"""
    try:
        page = frame["page"]
        x0, y0, x1, y1 = frame["x0"], frame["y0"], frame["x1"], frame["y1"]
        if int(page) != page or page < 0:
            raise ValueError("page")
        for v in (x0, y0, x1, y1):
            if not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
                raise ValueError("coord")
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            raise ValueError("empty")
    except (KeyError, TypeError, ValueError) as e:
        raise AppError(
            REGION_INVALID, f"框选坐标非法（page/x0/y0/x1/y1）：{e}", status_code=400
        ) from e


def _validate_label(label: str) -> str:
    label = label.strip()
    if not label or len(label) > _LABEL_MAX:
        raise AppError(
            REGION_INVALID, f"区域名称需为 1–{_LABEL_MAX} 个字符", status_code=400
        )
    return label


def _frame_hits(
    geometry: dict[tuple[int, ...], RegionGeometry],
    page: int,
    rect: tuple[float, float, float, float],
) -> list[tuple[tuple[int, ...], RegionGeometry]]:
    """矩形命中的文档流段落：page 一致且交叠宽高均 ≥ _MIN_HIT_DIM。"""
    rx0, ry0, rx1, ry1 = rect
    hits: list[tuple[tuple[int, ...], RegionGeometry]] = []
    for path, geo in geometry.items():
        if geo.page != page:
            continue
        gx0, gy0, gx1, gy1 = geo.bbox
        w = min(rx1, gx1) - max(rx0, gx0)
        h = min(ry1, gy1) - max(ry0, gy0)
        if w >= _MIN_HIT_DIM and h >= _MIN_HIT_DIM:
            hits.append((path, geo))
    return hits


def _maybe_mark_ready(conn: Any, template_id: int) -> None:
    """全部区域处理完毕（存在区域且无 pending）→ 模板转 ready（PRD 4.2）。"""
    regions = regions_repo.list_regions(conn, template_id)
    if regions and all(r.review_status != "pending" for r in regions):
        templates_repo.update_template(conn, template_id, status="ready")


def _bbox_payload(frame: dict[str, Any]) -> dict[str, Any]:
    """bbox 落库结构（M4 契约：PDF 点、原点左上、page 0 基，round 2 位）。"""
    return {
        "page": int(frame["page"]),
        "x0": round(float(frame["x0"]), 2),
        "y0": round(float(frame["y0"]), 2),
        "x1": round(float(frame["x1"]), 2),
        "y1": round(float(frame["y1"]), 2),
    }


def create_manual_region(
    template_id: int, label: str, region_type: str, frame: dict[str, Any]
) -> Region:
    """框选新建区域（PRD 4.3）：矩形反解回文档流段落 anchor，完成录入即 confirmed。"""
    _validate_frame(frame)
    label = _validate_label(label)

    with get_conn() as conn:
        tpl = templates_repo.get_template(conn, template_id)
        if tpl is None:
            raise AppError(TEMPLATE_NOT_FOUND, f"模板不存在（id={template_id}）", status_code=404)
    docx_path = settings.templates_dir / tpl.storage_name
    if not docx_path.is_file():
        raise AppError(
            RENDER_FAILED, f"模板文件缺失（{tpl.storage_name}），请重新上传模板", status_code=500
        )

    # 管线 PDF（顺带完成 bbox 生命周期维护）+ 行几何 → 反解 anchor
    pdf_path = render_service.ensure_template_preview(template_id)
    pdf_sha = render_service.pdf_sha256(pdf_path)
    flow = list(iter_flow_paragraphs(docx_path.read_bytes()))
    geometry = align_flow_to_lines(flow, extract_pdf_lines(pdf_path))
    hits = _frame_hits(
        geometry, int(frame["page"]), (frame["x0"], frame["y0"], frame["x1"], frame["y1"])
    )
    if not hits:
        raise AppError(
            REGION_FRAME_EMPTY, "框选范围内没有可识别的文本，请调整框选范围", status_code=400
        )
    if len(hits) > 1:
        raise AppError(
            REGION_FRAME_MULTI,
            f"框选范围覆盖 {len(hits)} 个段落，请逐段框选（v1 一个区域对应一段文本）",
            status_code=400,
        )
    path, _geo = hits[0]

    with get_conn() as conn:
        region = regions_repo.create_region(
            conn,
            template_id,
            region_type=region_type,
            label=label,
            anchor={"kind": "p" if len(path) == 1 else "cell_p", "path": list(path)},
            order_index=regions_repo.max_order_index(conn, template_id) + 1,
            bbox=_bbox_payload(frame),
            bbox_source="manual",
            bbox_pdf_sha=pdf_sha,
            confidence=None,
            review_status="confirmed",  # PRD：新建（手动框选）用户完成录入 → 已确认
        )
        _maybe_mark_ready(conn, template_id)
    return region


def update_region(
    region_id: int,
    *,
    label: str | None = None,
    region_type: str | None = None,
    review_status: str | None = None,
    bbox: dict[str, Any] | None = None,
) -> Region:
    """校对更新：确认/排除/重新校对（状态机）+ 命名/类型修改 + bbox 边界微调。

    bbox 一经人工提交即 manual（P21：渲染重算不覆盖人工校对产物）。
    """
    with get_conn() as conn:
        region = regions_repo.get_region(conn, region_id)
        if region is None:
            raise AppError(REGION_NOT_FOUND, f"区域不存在（id={region_id}）", status_code=404)
        if review_status is not None and review_status != region.review_status:
            if (region.review_status, review_status) not in _REVIEW_TRANSITIONS:
                raise AppError(
                    REGION_REVIEW_INVALID,
                    f"不允许从 {region.review_status} 变更为 {review_status}",
                    status_code=400,
                )
        updates: dict[str, Any] = {}
        if label is not None:
            updates["label"] = _validate_label(label)
        if region_type is not None:
            updates["region_type"] = region_type
        if review_status is not None:
            updates["review_status"] = review_status
        if bbox is not None:
            _validate_frame(bbox)
            updates["bbox"] = _bbox_payload(bbox)
            updates["bbox_source"] = "manual"
        if updates:
            updated = regions_repo.update_region(conn, region_id, **updates)
            assert updated is not None
        else:
            updated = region
        if review_status is not None:
            _maybe_mark_ready(conn, region.template_id)
    return updated


def delete_region(region_id: int) -> None:
    """删除区域（物理删，绑定 FK CASCADE）；删掉最后一个 pending 区域可能触发 ready。"""
    with get_conn() as conn:
        region = regions_repo.get_region(conn, region_id)
        if region is None:
            raise AppError(REGION_NOT_FOUND, f"区域不存在（id={region_id}）", status_code=404)
        regions_repo.delete_region(conn, region_id)
        _maybe_mark_ready(conn, region.template_id)
