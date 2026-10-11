import { describe, expect, it, vi } from 'vitest'
import { PageCanvasCache, verifiedPageFingerprints } from './pageCache'

describe('PDF 页级缓存', () => {
  it('相同画布与显示参数才复用；失败/取消后的页面必须重画', () => {
    const cache = new PageCanvasCache(), canvas = document.createElement('canvas')
    expect(cache.matches(canvas, 'hash', '1:1:612:792:2')).toBe(false)
    cache.completed(canvas, 'hash', '1:1:612:792:2')
    expect(cache.matches(canvas, 'hash', '1:1:612:792:2')).toBe(true)
    expect(cache.matches(document.createElement('canvas'), 'hash', '1:1:612:792:2')).toBe(false)
    expect(cache.matches(canvas, 'edited', '1:1:612:792:2')).toBe(false)
    expect(cache.matches(canvas, 'hash', '1:2:1224:1584:2')).toBe(false)
    expect(cache.matches(canvas, 'hash', '1:1:612:792:1')).toBe(false)
    cache.forget(canvas)
    expect(cache.matches(canvas, 'hash', '1:1:612:792:2')).toBe(false)
  })
  it('PDF 与 overlay 不同批次或缺少元数据时回退完整刷新', async () => {
    const data = new ArrayBuffer(4)
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array([1, 2]).buffer) } })
    try {
      expect(await verifiedPageFingerprints(data, {})).toEqual([])
      expect(await verifiedPageFingerprints(data, { pdf_sha256: 'other', page_fingerprints: ['page'] })).toEqual([])
      expect(await verifiedPageFingerprints(data, { pdf_sha256: '0102', page_fingerprints: ['page'] })).toEqual(['page'])
    } finally { vi.unstubAllGlobals() }
  })
})
