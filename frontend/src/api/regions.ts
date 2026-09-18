/** 校对域 API（M5b：PRD 4.3 候选确认/排除、框选新建、边界微调、删除）。 */

import { apiFetch } from './client'
import type { Region } from './templates'

/** 预览 PDF 上的矩形（后端 bbox 契约：PDF 点、原点左上、page 0 基）。 */
export interface RegionFramePayload {
  page: number
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface RegionCreatePayload {
  label: string
  type: string
  bbox: RegionFramePayload
}

export interface RegionPatchPayload {
  label?: string
  type?: string
  review_status?: string
  bbox?: RegionFramePayload
}

/** 框选新建：矩形 → 服务端反解文档流 anchor → confirmed 区域（201）。

 * 400 REGION_FRAME_EMPTY = 空区域拦截；REGION_FRAME_MULTI = 覆盖多段。 */
export function createRegion(
  templateId: number,
  payload: RegionCreatePayload,
): Promise<Region> {
  return apiFetch<Region>(`/api/templates/${templateId}/regions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 校对更新（部分）：review_status 状态机 / label / type / bbox 微调（→ manual 保护）。 */
export function updateRegion(
  regionId: number,
  patch: RegionPatchPayload,
): Promise<Region> {
  return apiFetch<Region>(`/api/regions/${regionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** 删除区域（绑定级联删除）。 */
export function deleteRegion(regionId: number): Promise<void> {
  return apiFetch<void>(`/api/regions/${regionId}`, { method: 'DELETE' })
}
