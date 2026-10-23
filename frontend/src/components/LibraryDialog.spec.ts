import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryDialog from './LibraryDialog.vue'
import { useDocumentsStore } from '../stores/documents'

vi.mock('./ArchivePreview.vue', () => ({ default: { template: '<div>只读 PDF</div>' } }))
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('独立归档库', () => {
  function sourceFixture() {
    const documents = useDocumentsStore()
    vi.spyOn(documents, 'load').mockImplementation(async () => {
      documents.error = null
      documents.groups = [{
        template: { id: 2, filename: '当前模板', storage_name: '', sha256: '', status: 'ready', created_at: '', updated_at: '', regions_count: 0 },
        documents: [{ id: 10, template_id: 2, name: '已改名的来源', created_at: '', updated_at: '', binding_count: 0 }],
        loading: false, loaded: true, error: null,
      }]
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ archives: [
      { id: 1, source_version_id: 10, name: '原稿定稿', template_name: '旧模板名', version_name: '旧文稿名', created_at: '' },
      { id: 2, source_version_id: 999, name: '来源已删定稿', template_name: '旧模板名', version_name: '旧文稿名', created_at: '' },
    ] })))
    return documents
  }
  it('按来源 ID 筛选，改名不丢关联，返回全部时清除范围和预览', async () => {
    sourceFixture()
    const wrapper = mount(LibraryDialog, { props: { embedded: true, sourceDocument: { id: 10, name: '已改名的来源' } } })
    await flushPromises()
    expect(wrapper.findAll('article')).toHaveLength(1)
    expect(wrapper.text()).toContain('当前来源：已改名的来源')
    await wrapper.findAll('article button').find(button => button.text() === '打开来源文稿')!.trigger('click')
    expect(wrapper.emitted('open-source')).toEqual([[2, 10]])
    await wrapper.findAll('article button').find(button => button.text() === '查看')!.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '查看全部归档')!.trigger('click')
    expect(wrapper.emitted('all')).toHaveLength(1)
    await wrapper.setProps({ sourceDocument: null })
    expect(wrapper.findAll('article')).toHaveLength(2)
    expect(wrapper.find('[aria-label=所选归档]').exists()).toBe(false)
    const orphan = wrapper.findAll('article')[1]!
    expect(orphan.text()).toContain('来源文稿已不存在')
    expect(orphan.findAll('a')).toHaveLength(2)
    expect(orphan.text()).not.toContain('打开来源文稿')
    wrapper.unmount()
  })
  it('来源读取失败不误判已删除，重试后恢复链接且不影响归档预览下载', async () => {
    const documents = sourceFixture()
    vi.mocked(documents.load).mockImplementationOnce(async () => { documents.error = '读取失败' })
    const wrapper = mount(LibraryDialog, { props: { embedded: true } })
    await flushPromises()
    expect(wrapper.text()).toContain('来源暂无法核对')
    expect(wrapper.text()).not.toContain('来源文稿已不存在')
    expect(wrapper.findAll('a')).toHaveLength(4)
    await wrapper.findAll('button').find(button => button.text() === '重试核对来源')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('打开来源文稿')
    wrapper.unmount()
  })
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
