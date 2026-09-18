/** 块域 API 与类型（对应后端 /api/blocks，M6a 最小实现）。 */

import { apiFetch } from './client'

/** 字符块（内容资产主体，软删除块不出列表）。 */
export interface Block {
  id: number
  name: string
  content: string
  category: string
  created_at: string
  updated_at: string
}

/** 块列表（存活块，创建正序）。 */
export async function listBlocks(): Promise<Block[]> {
  const body = await apiFetch<{ blocks: Block[] }>('/api/blocks')
  return body.blocks
}

/** 新建块（名称 2–30 字 / 内容 ≤5000 字，后端校验）。 */
export function createBlock(payload: {
  name: string
  content: string
  category?: string
}): Promise<Block> {
  return apiFetch<Block>('/api/blocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
