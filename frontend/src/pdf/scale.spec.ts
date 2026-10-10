import { describe, expect, it } from 'vitest'
import { previewScale } from './scale'

describe('PDF 预览缩放', () => {
  it('整页同时满足宽高边界，宽屏不会把页面放大到视窗之外', () => {
    const scale = previewScale('page', 1200, 800, 600, 900)
    expect(scale * 900).toBeLessThanOrEqual(768)
    expect(scale * 600).toBeLessThanOrEqual(1168)
  })
  it('适合宽度可纵向滚动，固定比例不受侧栏宽度影响', () => {
    expect(previewScale('width', 632, 700, 600, 900)).toBe(1)
    expect(previewScale('1.25', 360, 700, 600, 900)).toBe(1.25)
    expect(previewScale('1.25', 1200, 700, 600, 900)).toBe(1.25)
  })
  it('折叠过渡中的零尺寸与非法比例不会生成负尺寸', () => {
    expect(previewScale('page', 0, 0, 600, 900)).toBe(0.1)
    expect(previewScale('bad', 0, 0, 600, 900)).toBe(1)
  })
})
