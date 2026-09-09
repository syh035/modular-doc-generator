/**
 * pdfjs-dist 封装：加载管线 PDF、逐页渲染到 canvas（单管线铁律，P2）。
 *
 * 只读预览（M5a）：fit-width 缩放由调用方计算后传入。
 * 组件测试通过 vi.mock 本模块绕开真实 pdfjs（jsdom 无 canvas）。
 */

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'

// Vite：worker 走 URL 导入，交由打包器解析（pdfjs v4+ 标准 ESM 用法）
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

/** 打开的文档句柄：document 供渲染，destroy 归属 loadingTask（pdfjs 6.x）。 */
export interface OpenedPdf {
  document: PDFDocumentProxy
  destroy(): Promise<void>
}

/** 加载 PDF 文档（拷贝 data 后交给 pdfjs，所有权归其内部）。 */
export async function openDocument(data: ArrayBuffer): Promise<OpenedPdf> {
  const task = pdfjs.getDocument({ data: data.slice(0) })
  const document = await task.promise
  return { document, destroy: () => task.destroy() }
}

export interface RenderedPage {
  index: number // 0 基页码
  /** CSS 像素尺寸（已按 scale 缩放，未乘 dpr）。 */
  width: number
  height: number
  /** 与 canvas 绘制同源的 viewport（覆盖层换算用，勿重建）。 */
  viewport: PageViewport
  render: (canvas: HTMLCanvasElement) => Promise<void>
}

/**
 * 准备一页的渲染描述：viewport 只建一次（覆盖层换算与 canvas 绘制同源），
 * render() 可在 canvas 挂载到 DOM 后执行。
 */
export function preparePage(page: PDFPageProxy, scale: number): RenderedPage {
  const viewport = page.getViewport({ scale })
  return {
    index: page.pageNumber - 1,
    width: viewport.width,
    height: viewport.height,
    viewport,
    render: async (canvas: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(viewport.width * dpr)
      canvas.height = Math.round(viewport.height * dpr)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      await page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise
    },
  }
}
