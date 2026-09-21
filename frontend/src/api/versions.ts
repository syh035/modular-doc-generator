/** 版本域 API 与类型（对应后端 /api/versions，M6a：绑定 + 版本渲染）。 */

import { apiFetch } from './client'
import type { Region } from './templates'

/** 区域绑定态（版本 overlay 附带）。 */
export interface BindingInfo {
  block_id: number
  block_name: string | null
  status: string // active / missing
}

/** 区域溢出报告（M7，D4/P6）：高度对比分级 + 固定行高裁剪；null = 未测量。 */
export interface OverflowInfo {
  orig_height: number
  new_height: number
  ratio: number
  level: 'small' | 'large'
  clipped: boolean
  fixed_row: boolean
}

/** 版本 overlay 区域：模板区域 + 替换后 bbox + 绑定态 + 溢出报告。 */
export interface OverlayRegion extends Region {
  binding: BindingInfo | null
  overflow: OverflowInfo | null
}

/** 绑定（正/反向点选产物；换绑 = 同端点覆盖）。 */
export function bindRegion(
  versionId: number,
  regionId: number,
  blockId: number,
): Promise<BindingInfo & { version_id: number; region_id: number }> {
  return apiFetch(`/api/versions/${versionId}/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region_id: regionId, block_id: blockId }),
  })
}

/** 解绑。 */
export function unbindRegion(versionId: number, regionId: number): Promise<void> {
  return apiFetch<void>(`/api/versions/${versionId}/bindings/${regionId}`, {
    method: 'DELETE',
  })
}

/** 版本预览 PDF 地址（模板 + 绑定替换后的成品，单管线铁律）。 */
export function versionPreviewUrl(versionId: number): string {
  return `/api/versions/${versionId}/preview`
}

/** 版本 overlay：区域 × 替换后 bbox × 绑定态（随渲染现算）。 */
export async function fetchVersionOverlay(versionId: number): Promise<OverlayRegion[]> {
  const body = await apiFetch<{ regions: OverlayRegion[] }>(
    `/api/versions/${versionId}/overlay`,
  )
  return body.regions
}
