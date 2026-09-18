"""API 入口：/api/regions 校对操作（M5b，PRD 4.3）+ 模板域框选新建。

四类操作：候选确认/排除（PATCH review_status）、框选新建（POST，
服务端几何反解 anchor）、边界微调（PATCH bbox → manual 保护）、删除
（DELETE，绑定 FK CASCADE）。全部逐操作落库（中断续作）。
"""

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api.templates import region_dict
from app.services import proofread_service

router = APIRouter(prefix="/api")


class RegionFrame(BaseModel):
    """预览 PDF 上的矩形（PDF 点、原点左上、page 0 基——M4 bbox 契约）。"""

    page: int
    x0: float
    y0: float
    x1: float
    y1: float


class RegionCreate(BaseModel):
    label: str
    type: str
    bbox: RegionFrame


class RegionUpdate(BaseModel):
    label: str | None = None
    type: str | None = None
    review_status: str | None = None
    bbox: RegionFrame | None = None


@router.post("/templates/{template_id}/regions", status_code=201)
def create_region(template_id: int, payload: RegionCreate) -> JSONResponse:
    """框选新建区域：矩形 → 反解文档流段落 anchor → confirmed 区域。

    400 REGION_FRAME_EMPTY = 空区域拦截；REGION_FRAME_MULTI = 覆盖多段
    （v1 一个区域对应一段文本，请逐段框选）。
    """
    region = proofread_service.create_manual_region(
        template_id,
        payload.label,
        payload.type,
        payload.bbox.model_dump(),
    )
    return JSONResponse(status_code=201, content=region_dict(region))


@router.patch("/regions/{region_id}")
def patch_region(region_id: int, payload: RegionUpdate) -> dict[str, object]:
    """校对更新：确认/排除/重新校对 + 命名/类型修改 + bbox 边界微调（部分更新）。"""
    region = proofread_service.update_region(
        region_id,
        label=payload.label,
        region_type=payload.type,
        review_status=payload.review_status,
        bbox=payload.bbox.model_dump() if payload.bbox is not None else None,
    )
    return region_dict(region)


@router.delete("/regions/{region_id}", status_code=204)
def delete_region(region_id: int) -> Response:
    """删除区域；不存在 → 404。"""
    proofread_service.delete_region(region_id)
    return Response(status_code=204)
