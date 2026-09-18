import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GuidePage from './GuidePage.vue'

/** jsdom 无 clipboard，stub writeText。 */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
  return writeText
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GuidePage（模板制作指南，UI 调整①）', () => {
  it('渲染三大 section', () => {
    const wrapper = mount(GuidePage)
    const headings = wrapper.findAll('h2')
    expect(headings.map(h => h.text())).toEqual([
      '占位符怎么写',
      '示例段落（点击复制）',
      '示例模板',
    ])
  })

  it('点击复制按钮调用 clipboard.writeText 并显示「已复制」', async () => {
    const writeText = stubClipboard()
    const wrapper = mount(GuidePage)
    const firstCopyBtn = wrapper.findAll('.copy-btn')[0]
    await firstCopyBtn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(firstCopyBtn.text()).toContain('已复制')
  })

  it('下载链接指向后端示例模板端点', () => {
    const wrapper = mount(GuidePage)
    const link = wrapper.find('.download-link')
    expect(link.attributes('href')).toBe('/api/guide/sample-template')
    expect(link.attributes('download')).toBeTruthy()
  })
})
