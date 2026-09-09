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

/** 覆盖层视觉状态：绿=已绑定（M6a 接数据）/ 黄=待校对 / 虚线灰=未识别。 */
export type OverlayKind = 'bound' | 'pending' | 'unrecognized'

export function overlayKind(region: { bbox: BBox | null }): OverlayKind {
  if (region.bbox === null) {
    return 'unrecognized'
  }
  // M5a 无绑定数据；M6a 接入 bindings 后在此改为查询绑定态返回 'bound'
  return 'pending'
}
