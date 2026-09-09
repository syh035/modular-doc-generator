import { describe, expect, it } from 'vitest'
import type { BBox } from '../api/templates'
import { bboxToOverlayRect, overlayKind, type ViewportLike } from './geometry'

/** rotation=0 的最小 viewport 替身：与 pdfjs PageViewport 变换一致（y 轴翻转）。 */
function fakeViewport(scale: number, pageHeight: number): ViewportLike {
  return {
    viewBox: [0, 0, 612, pageHeight],
    convertToViewportPoint(x: number, y: number): number[] {
      return [x * scale, (pageHeight - y) * scale]
    },
  }
}

describe('bboxToOverlayRect', () => {
  const bbox: BBox = { page: 0, x0: 100, y0: 200, x1: 300, y1: 250 }

  it('无旋转 viewport：按 scale 缩放且 y 不翻转（top-left 系直出）', () => {
    const vp = fakeViewport(1.5, 800)
    const rect = bboxToOverlayRect(bbox, vp)
    // x: 100*1.5 ~ 300*1.5；y(top-left): 200*1.5 ~ 250*1.5
    expect(rect).toEqual({ left: 150, top: 300, width: 300, height: 75 })
  })

  it('scale=1 时恒等', () => {
    const vp = fakeViewport(1, 800)
    const rect = bboxToOverlayRect(bbox, vp)
    expect(rect).toEqual({ left: 100, top: 200, width: 200, height: 50 })
  })

  it('bbox 坐标系翻转正确（y 越大越靠下）', () => {
    const upper: BBox = { page: 0, x0: 0, y0: 0, x1: 10, y1: 10 }
    const lower: BBox = { page: 0, x0: 0, y0: 700, x1: 10, y1: 710 }
    const vp = fakeViewport(1, 800)
    expect(bboxToOverlayRect(upper, vp).top).toBeLessThan(bboxToOverlayRect(lower, vp).top)
  })

  it('零尺寸 bbox（空区域）得到零宽高矩形', () => {
    const zero: BBox = { page: 0, x0: 50, y0: 60, x1: 50, y1: 60 }
    const rect = bboxToOverlayRect(zero, fakeViewport(2, 800))
    expect(rect).toEqual({ left: 100, top: 120, width: 0, height: 0 })
  })
})

describe('overlayKind', () => {
  it('bbox=null → unrecognized（虚线灰）', () => {
    expect(overlayKind({ bbox: null })).toBe('unrecognized')
  })

  it('有 bbox → pending（黄，M5a 无绑定数据）', () => {
    expect(overlayKind({ bbox: { page: 0, x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe('pending')
  })
})
