/** Match metadata to the exact downloaded PDF before allowing page reuse. */
import type { PdfPageMetadata } from '../api/versions'
export async function verifiedPageFingerprints(data: ArrayBuffer, meta: PdfPageMetadata): Promise<string[]> {
  if (!meta.pdf_sha256 || !meta.page_fingerprints?.length || !globalThis.crypto?.subtle) return []
  let hash: ArrayBuffer
  try { hash = await crypto.subtle.digest('SHA-256', data) } catch { return [] }
  const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
  return hex === meta.pdf_sha256 ? meta.page_fingerprints : []
}

interface Stamp { content: string | ArrayBuffer; layout: string }
/** Only reuse completed pixels on the same canvas at the same size/scale/DPR. */
export class PageCanvasCache {
  private stamps = new WeakMap<HTMLCanvasElement, Stamp>()
  matches(canvas: HTMLCanvasElement, content: string | ArrayBuffer, layout: string): boolean {
    const stamp = this.stamps.get(canvas)
    return stamp?.content === content && stamp?.layout === layout
  }
  forget(canvas: HTMLCanvasElement): void { this.stamps.delete(canvas) }
  completed(canvas: HTMLCanvasElement, content: string | ArrayBuffer, layout: string): void {
    this.stamps.set(canvas, { content, layout })
  }
}
