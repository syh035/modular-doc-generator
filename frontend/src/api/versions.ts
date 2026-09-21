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

/** 版本信息（列表项，binding_count = active 绑定数）。 */
export interface VersionInfo {
  id: number
  template_id: number
  name: string
  binding_count: number
  created_at: string
  updated_at: string
}

/** 版本管理（M8）：列表。 */
export async function listVersions(templateId: number): Promise<VersionInfo[]> {
  const body = await apiFetch<{ versions: VersionInfo[] }>(
    `/api/templates/${templateId}/versions`,
  )
  return body.versions
}

/** 新建版本（空白 / copy_from 复制该版本 active 绑定为底稿）。 */
export function createVersion(
  templateId: number,
  name: string,
  copyFrom?: number,
): Promise<VersionInfo> {
  return apiFetch<VersionInfo>(`/api/templates/${templateId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, copy_from: copyFrom ?? null }),
  })
}

/** 重命名（同模板内唯一）。 */
export function renameVersion(versionId: number, name: string): Promise<VersionInfo> {
  return apiFetch<VersionInfo>(`/api/versions/${versionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** 删除版本（模板至少保留一个；绑定随级联删）。 */
export function deleteVersion(versionId: number): Promise<void> {
  return apiFetch<void>(`/api/versions/${versionId}`, { method: 'DELETE' })
}
