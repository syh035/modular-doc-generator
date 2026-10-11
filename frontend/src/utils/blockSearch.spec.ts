import { describe, expect, it } from 'vitest'
import { matchesBlock } from './blockSearch'
const block = { id: 1, name: '工作经历', content: 'Vue 前端开发', tags: [{ id: 2, name: '技术' }], created_at: '', updated_at: '' }
describe('内容块共享搜索', () => {
  it('名称、正文与标签均可找到块，英文不区分大小写并忽略首尾空格', () => {
    for (const query of ['工作', ' VUE ', '技术', '']) expect(matchesBlock(block, query)).toBe(true)
    expect(matchesBlock(block, '教育')).toBe(false)
  })
  it('搜索与标签筛选取交集，标签不会被关键词绕过', () => {
    expect(matchesBlock(block, 'vue', 2)).toBe(true)
    expect(matchesBlock(block, 'vue', 3)).toBe(false)
  })
})
