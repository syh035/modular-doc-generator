/**
 * 覆盖层几何换算（纯函数，无 DOM 依赖，可直接单测）。
 *
 * 后端 bbox 契约（M4）：PDF 点、原点左上、page 0 基。
 * pdfjs viewport 的用户空间原点在左下，转换需先翻转 y 轴。
 */

import type { BBox } from '../api/templates'

/** pdfjs PageViewport 的最小结构（便于测试替身）。 */
export interface ViewportLike {
  /** [x0, y0, x1, y1] 用户空间（原点左下）；页高 = viewBox[3]。 */
  viewBox: number[]
  convertToViewportPoint(x: number, y: number): number[]
  /** 逆换算：CSS 像素 → PDF 用户空间（M5b 框选/微调用，pdfjs PageViewport 原生方法）。 */
  convertToPdfPoint(x: number, y: number): number[]
}

/** 覆盖层矩形（CSS 像素，相对页容器左上）。 */
export interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

/** bbox（PDF 点、原点左上）→ 覆盖层 CSS 像素矩形。 */
export function bboxToOverlayRect(bbox: BBox, viewport: ViewportLike): OverlayRect {
  // 左上系 y → 用户空间（左下系）y：y_user = pageHeight - y_topLeft
  const pageHeight = viewport.viewBox[3]
  const [x1, y1] = viewport.convertToViewportPoint(bbox.x0, pageHeight - bbox.y1)
  const [x2, y2] = viewport.convertToViewportPoint(bbox.x1, pageHeight - bbox.y0)
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  return {
    left,
    top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

/**
 * 覆盖层 CSS 像素矩形 → bbox（PDF 点、原点左上），bboxToOverlayRect 的逆换算。
 * M5b 框选/微调：页码由调用方附上（拖拽天然单页）。
 */
export function overlayRectToBBox(
  rect: OverlayRect,
  viewport: ViewportLike,
): Omit<BBox, 'page'> {
  const pageHeight = viewport.viewBox[3]
  const [ux0, uy0] = viewport.convertToPdfPoint(rect.left, rect.top)
  const [ux1, uy1] = viewport.convertToPdfPoint(rect.left + rect.width, rect.top + rect.height)
  const x0 = Math.min(ux0, ux1)
  const x1 = Math.max(ux0, ux1)
  // 用户空间 y（左下原点）→ 左上原点：y_top = pageHeight - y_user
  const yTop = pageHeight - Math.max(uy0, uy1)
  const yBottom = pageHeight - Math.min(uy0, uy1)
  const r2 = (v: number) => Math.round(v * 100) / 100
  return { x0: r2(x0), y0: r2(yTop), x1: r2(x1), y1: r2(yBottom) }
}

/** 覆盖层视觉状态：绿=已绑定（active）/ 黄=待校对（含 missing 绑定回落）/ 虚线灰=未识别。 */
export type OverlayKind = 'bound' | 'pending' | 'unrecognized'

/** overlayKind 入参最小结构（M6a：绑定态接入）。 */
export interface OverlayRegionLike {
  bbox: BBox | null
  binding?: { status: string } | null
}

export function overlayKind(region: OverlayRegionLike): OverlayKind {
  if (region.bbox === null) {
    return 'unrecognized'
  }
  // active 绑定 = 绿；无绑定或 missing（块已删，内容回落原文）= 黄
  if (region.binding && region.binding.status === 'active') {
    return 'bound'
  }
  return 'pending'
}
