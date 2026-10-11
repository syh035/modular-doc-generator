import type { Block } from '../api/blocks'

/** 块库与绑定选择共用查询：名称、正文或标签命中；可叠加标签筛选。 */
export function matchesBlock(block: Block, query: string, tagId: number | null = null): boolean {
  if (tagId !== null && !block.tags.some(t => t.id === tagId)) return false
  const keyword = query.trim().toLocaleLowerCase()
  return !keyword || [block.name, block.content, ...block.tags.map(t => t.name)]
    .some(text => text.toLocaleLowerCase().includes(keyword))
}
