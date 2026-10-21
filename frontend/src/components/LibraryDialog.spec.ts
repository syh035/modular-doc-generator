import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryDialog from './LibraryDialog.vue'

vi.mock('./ArchivePreview.vue', () => ({ default: { template: '<div>只读 PDF</div>' } }))
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('独立归档库', () => {
  it('页面删除归档后回到搜索输入', async () => {
    const archive = { id: 7, name: '定稿', template_name: '模板', version_name: '文稿', created_at: '2026-10-17T00:00:00Z' }
    let deleted = false
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }) }
      return Response.json({ archives: deleted ? [] : [archive] })
    }))
    const wrapper = mount(LibraryDialog, { props: { embedded: true }, attachTo: document.body })
    try {
      await flushPromises()
      const remove = wrapper.findAll('article button').find(button => button.text() === '删除')!
      ;(remove.element as HTMLButtonElement).focus()
      await remove.trigger('click')
      await flushPromises()
      expect(wrapper.find('article').exists()).toBe(false)
      expect(document.activeElement).toBe(wrapper.get('input[type=search]').element)
    } finally { wrapper.unmount() }
  })
  it('主页面无模态和关闭按钮，读取失败可重试，不依赖工作稿上下文', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(Response.json({ archives: [] }))
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(LibraryDialog, { props: { embedded: true } })
    await flushPromises()
    expect(wrapper.element.tagName).toBe('MAIN')
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.find('[aria-label=关闭归档库]').exists()).toBe(false)
    await wrapper.get('[role=alert] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role=alert]').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无归档')
    wrapper.unmount()
  })
  it('无需选择模板或版本即可查看下载，不再请求备份接口', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ archives: [
      { id: 7, name: '定稿', template_name: '模板', version_name: '版本', created_at: '2026-10-17T00:00:00Z' },
    ] })))
    vi.stubGlobal('fetch', fetcher)
    const wrapper = mount(LibraryDialog)
    await flushPromises()
    expect(wrapper.attributes('aria-label')).toBe('归档库')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('a[download]').attributes('href')).toBe('/api/archives/7/docx')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/archives'])
    expect(wrapper.text()).not.toContain('备份')
    wrapper.unmount()
  })
  it('可直接打开刚保存的归档，并按名称或来源搜索', async () => {
    const archive = { id: 1, name: '定稿', template_name: '模板', version_name: '版本', created_at: '2026-10-17T00:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ archives: [archive] })))
    const wrapper = mount(LibraryDialog, { props: { initialArchiveId: 1 } })
    await flushPromises()
    expect(wrapper.text()).toContain('只读 PDF')
    await wrapper.get('input[type=search]').setValue('模板')
    expect(wrapper.findAll('article')).toHaveLength(1)
    await wrapper.get('input[type=search]').setValue('不存在')
    expect(wrapper.findAll('article')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有找到匹配的归档')
    wrapper.unmount()
  })
  it('加载失败明确报错，不误显示为空库', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('disconnected')))
    const wrapper = mount(LibraryDialog)
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('无法连接本地服务')
    expect(wrapper.text()).not.toContain('暂无归档')
    wrapper.unmount()
  })
  it('查看时明确展示所选归档，可收起预览回到完整列表', async () => {
    const archive = { id: 7, name: '投递留存', template_name: '模板', version_name: '版本', created_at: '2026-10-17T00:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ archives: [archive] })))
    const wrapper = mount(LibraryDialog)
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '查看')!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label=所选归档] h3').text()).toBe('投递留存')
    expect(wrapper.get('[aria-label=所选归档]').text()).toContain('只读 PDF')
    await wrapper.findAll('button').find(button => button.text() === '收起预览')!.trigger('click')
    expect(wrapper.find('[aria-label=所选归档]').exists()).toBe(false)
    expect(wrapper.findAll('article')).toHaveLength(1)
    wrapper.unmount()
  })
})
