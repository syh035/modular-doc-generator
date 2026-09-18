import { describe, expect, it } from 'vitest'
import type { BBox } from '../api/templates'
import { bboxToOverlayRect, overlayKind, overlayRectToBBox, type ViewportLike } from './geometry'

/** rotation=0 的最小 viewport 替身：与 pdfjs PageViewport 变换一致（y 轴翻转）。 */
function fakeViewport(scale: number, pageHeight: number): ViewportLike {
  return {
    viewBox: [0, 0, 612, pageHeight],
    convertToViewportPoint(x: number, y: number): number[] {
      return [x * scale, (pageHeight - y) * scale]
    },
    convertToPdfPoint(x: number, y: number): number[] {
      return [x / scale, pageHeight - y / scale]
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

describe('overlayRectToBBox（M5b 框选/微调逆换算）', () => {
  it('scale=1：CSS 矩形 → PDF 点（左上原点），y 轴正确翻转', () => {
    const vp = fakeViewport(1, 800)
    // scale=1 时左上原点 y 恒等于 CSS top（y0=上沿、y1=下沿）
    const b = overlayRectToBBox({ left: 100, top: 200, width: 200, height: 50 }, vp)
    expect(b).toEqual({ x0: 100, y0: 200, x1: 300, y1: 250 })
  })

  it('scale=1.5：缩放逆运算正确', () => {
    const vp = fakeViewport(1.5, 800)
    const b = overlayRectToBBox({ left: 150, top: 300, width: 300, height: 75 }, vp)
    expect(b).toEqual({ x0: 100, y0: 200, x1: 300, y1: 250 })
  })

  it('round-trip：bbox → rect → bbox 恒等（2 位小数舍入内）', () => {
    const vp = fakeViewport(1.37, 792)
    const bbox: BBox = { page: 0, x0: 72.5, y0: 111.11, x1: 500.25, y1: 400.99 }
    const rect = bboxToOverlayRect(bbox, vp)
    const back = overlayRectToBBox(rect, vp)
    expect(back.x0).toBeCloseTo(bbox.x0, 1)
    expect(back.y0).toBeCloseTo(bbox.y0, 1)
    expect(back.x1).toBeCloseTo(bbox.x1, 1)
    expect(back.y1).toBeCloseTo(bbox.y1, 1)
  })

  it('坐标四舍五入到 2 位小数（后端 bbox 契约）', () => {
    const vp = fakeViewport(1, 800)
    const b = overlayRectToBBox({ left: 10.123, top: 100.456, width: 33.333, height: 22.222 }, vp)
    expect(b.x0).toBe(10.12)
    expect(b.y0).toBe(100.46) // 800 - (800 - 100.456)
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
