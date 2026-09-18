/** 块域 API 与类型（对应后端 /api/blocks、/api/tags，M2 完整化）。 */

import { apiFetch } from './client'

/** 块上的标签（精简引用）。 */
export interface BlockTag {
  id: number
  name: string
}

/** 字符块（内容资产主体，软删除块不出列表）。 */
export interface Block {
  id: number
  name: string
  content: string
  category: string
  tags: BlockTag[]
  created_at: string
  updated_at: string
}

/** 标签（含存活块引用计数，供筛选侧栏）。 */
export interface TagInfo {
  id: number
  name: string
  block_count: number
  created_at: string
}

/** 块更新载荷（部分更新：仅传入字段生效；tags 传入即整组替换）。 */
export interface BlockPayload {
  name?: string
  content?: string
  category?: string
  tags?: string[]
}

/** 块列表（存活块，创建正序，含各自标签组）。 */
export async function listBlocks(): Promise<Block[]> {
  const body = await apiFetch<{ blocks: Block[] }>('/api/blocks')
  return body.blocks
}

/** 块详情。 */
export function fetchBlock(id: number): Promise<Block> {
  return apiFetch<Block>(`/api/blocks/${id}`)
}

/** 新建块（名称 2–30 字 / 内容 ≤5000 字 / 标签 ≤10 个，后端校验；标签名不存在自动创建）。 */
export function createBlock(payload: BlockPayload): Promise<Block> {
  return apiFetch<Block>('/api/blocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 更新块（部分更新）。 */
export function updateBlock(id: number, payload: BlockPayload): Promise<Block> {
  return apiFetch<Block>(`/api/blocks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 软删除块（D11）：关联绑定置 missing。 */
export async function deleteBlock(id: number): Promise<void> {
  await apiFetch<void>(`/api/blocks/${id}`, { method: 'DELETE' }) // 204 无响应体
}

/** 标签列表（含存活块计数，按名称排序）。 */
export async function listTags(): Promise<TagInfo[]> {
  const body = await apiFetch<{ tags: TagInfo[] }>('/api/tags')
  return body.tags
}

/** 重命名标签；新名撞已有标签 → 合并（返回目标标签）。 */
export function renameTag(id: number, name: string): Promise<TagInfo> {
  return apiFetch<TagInfo>(`/api/tags/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** 删除标签（块关联级联清理，块本身不受影响）。 */
export async function deleteTag(id: number): Promise<void> {
  await apiFetch<void>(`/api/tags/${id}`, { method: 'DELETE' }) // 204 无响应体
}
