import { describe, expect, it, vi } from 'vitest'
const getDocument = vi.hoisted(() => vi.fn(() => ({ promise: Promise.resolve({ numPages: 1 }), destroy: vi.fn() })))
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }))
import { openDocument } from './viewer'
describe('本地 PDF 字体资源', () => {
  it('拷贝字节，CMap 和标准字体使用本地资源', async () => {
    const data = new ArrayBuffer(4)
    await openDocument(data)
    const options = getDocument.mock.calls[0] as unknown as [{ data: ArrayBuffer; cMapUrl: string; cMapPacked: boolean; standardFontDataUrl: string }]
    expect(options[0].data).not.toBe(data)
    expect(options[0].cMapUrl).toBe('/pdfjs/cmaps/')
    expect(options[0].cMapPacked).toBe(true)
    expect(options[0].standardFontDataUrl).toBe('/pdfjs/standard_fonts/')
  })
})
