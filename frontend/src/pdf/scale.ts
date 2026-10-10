/** CSS 像素与 PDF 点的缩放：留出画布内边距，避免出现负尺寸。 */
export function previewScale(mode: string, width: number, height: number, pageWidth: number, pageHeight: number): number {
  const fitWidth = (width - 32) / pageWidth
  const fitPage = Math.min(fitWidth, (height - 32) / pageHeight)
  const scale = mode === 'width' ? fitWidth : mode === 'page' ? fitPage : Number(mode)
  return Math.max(0.1, Math.min(4, Number.isFinite(scale) ? scale : 1))
}
