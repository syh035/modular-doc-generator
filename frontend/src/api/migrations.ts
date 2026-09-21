/** 迁移域 API 与类型（对应后端 /api/templates/{id}/migrate/*，M10，PRD 4.7 / D7）。 */

import { apiFetch } from './client'

/** 目标区域候选选项（②同类型候选 / ③手动指定候选通用）。 */
export interface MigrationOption {
  region_id: number
  label: string
  type: string
}

/** ① 自动匹配成功行（只读展示）。 */
export interface MigrationAutoItem {
  source_region_id: number
  source_label: string
  target_region_id: number
  target_label: string
  block_id: number
  block_name: string | null
}

/** ② 多候选行：用户从同类型候选中点选一个（前端按序预选默认）。 */
export interface MigrationCandidateItem {
  source_region_id: number
  source_label: string
  block_id: number
  block_name: string | null
  options: MigrationOption[]
}

/** ③ 无匹配行：手动指定任意未占用区域，或留空。 */
export interface MigrationUnmatchedItem {
  source_region_id: number
  source_label: string
  block_id: number
  block_name: string | null
  manual_options: MigrationOption[]
}

/** 迁移方案（plan 端点返回，纯计算不落库）。 */
export interface MigrationPlan {
  source_version_id: number
  source_version_name: string
  source_template_id: number
  target_template_id: number
  target_version_id: number
  auto: MigrationAutoItem[]
  candidates: MigrationCandidateItem[]
  unmatched: MigrationUnmatchedItem[]
}

/** 拉取迁移方案（纯计算不落库）。 */
export function fetchMigrationPlan(
  templateId: number,
  sourceVersionId: number,
): Promise<MigrationPlan> {
  return apiFetch<MigrationPlan>(`/api/templates/${templateId}/migrate/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_version_id: sourceVersionId }),
  })
}

/** 应用迁移：三清单确认结果整包提交（目标默认版本须空白）。 */
export function applyMigration(
  templateId: number,
  sourceVersionId: number,
  bindings: { region_id: number; block_id: number }[],
): Promise<{ version_id: number; created: number }> {
  return apiFetch<{ version_id: number; created: number }>(
    `/api/templates/${templateId}/migrate/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_version_id: sourceVersionId, bindings }),
    },
  )
}
