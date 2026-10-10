import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVersion, deleteVersion, listVersions, renameVersion, type VersionInfo } from '../api/versions'
import { usePreviewStore } from '../stores/preview'
import TemplateManager from './TemplateManager.vue'

vi.mock('../api/versions', async importOriginal => ({
  ...await importOriginal<typeof import('../api/versions')>(),
  listVersions: vi.fn(), createVersion: vi.fn(), renameVersion: vi.fn(), deleteVersion: vi.fn(),
}))
const versions: VersionInfo[] = [
  { id: 5, template_id: 1, name: '默认版本', binding_count: 2, created_at: '', updated_at: '' },
  { id: 6, template_id: 1, name: '研发投递', binding_count: 1, created_at: '', updated_at: '' },
]
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(listVersions).mockImplementation(async id => versions.map(v => ({ ...v, template_id: id, id: id === 1 ? v.id : v.id + 10 })))
  const store = usePreviewStore()
  store.currentTemplateId = 1
  store.currentVersionId = 5
  store.templates = [1, 2].map(id => ({ id, filename: id === 1 ? '简历模板.docx' : '项目总结.docx', regions_count: 3, status: 'ready', created_at: '', updated_at: '', storage_name: '', sha256: '' }))
  store.versions = versions.map(v => ({ ...v }))
})
async function manager() { const wrapper = mount(TemplateManager); await flushPromises(); return wrapper }
function button(wrapper: ReturnType<typeof mount>, text: string) { return wrapper.findAll('button').find(b => b.text() === text)! }

describe('模板与版本管理', () => {
  it('全选仅含当前搜索结果；切换搜索清除选择', async () => {
    const wrapper = await manager()
    await button(wrapper, '批量管理').trigger('click')
    await wrapper.get('input[type="search"]').setValue('项目')
    await wrapper.get('[aria-label="全选当前模板列表"]').setValue(true)
    expect(wrapper.text()).toContain('批量删除（1）')
    expect(wrapper.findAll('.template-row')).toHaveLength(1)
    await wrapper.get('input[type="search"]').setValue('')
    expect(wrapper.text()).toContain('批量删除（0）')
  })
  it('批量删除保留受保护模板并显示部分成功结果；须确认后执行', async () => {
    const wrapper = await manager()
    const store = usePreviewStore()
    const spy = vi.spyOn(store, 'removeTemplate').mockImplementation(async id => {
      if (id === 1) return { ok: false, error: '模板仍有有效绑定' }
      store.templates = store.templates.filter(t => t.id !== id)
      return { ok: true, error: null }
    })
    await button(wrapper, '批量管理').trigger('click')
    await wrapper.get('[aria-label="全选当前模板列表"]').setValue(true)
    await button(wrapper, '批量删除（2）').trigger('click')
    expect(spy).not.toHaveBeenCalled()
    await button(wrapper, '确认删除模板').trigger('click')
    await flushPromises()
    expect(spy.mock.calls.map(c => c[0])).toEqual([1, 2])
    expect(wrapper.text()).toContain('已删除 1 个模板')
    expect(wrapper.text()).toContain('模板仍有有效绑定')
    expect(wrapper.text()).toContain('批量删除（1）')
    expect(store.templates.map(t => t.id)).toEqual([1])
  })
  it('删除最后一个模板后面板仍可关闭和导入', async () => {
    const store = usePreviewStore()
    store.templates = [store.templates[0]]
    vi.spyOn(store, 'removeTemplate').mockImplementation(async () => {
      store.templates = []
      store.currentTemplateId = null
      return { ok: true, error: null }
    })
    const wrapper = await manager()
    await button(wrapper, '删除模板').trigger('click')
    await button(wrapper, '确认删除模板').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('导入 DOCX 模板开始使用')
    expect(wrapper.findAll('.version-item')).toHaveLength(0)
    expect(button(wrapper, '导入模板').attributes('disabled')).toBeUndefined()
  })
  it('搜索模板并浏览时不改变工作台；显式使用才发出切换请求', async () => {
    const wrapper = await manager()
    const store = usePreviewStore()
    await wrapper.get('input[type="search"]').setValue('项目')
    expect(wrapper.findAll('.template-item')).toHaveLength(1)
    await wrapper.get('.template-item').trigger('click')
    await flushPromises()
    expect(store.currentTemplateId).toBe(1)
    await button(wrapper, '使用').trigger('click')
    expect(wrapper.emitted('use')).toEqual([[2, 15]])
  })
  it('创建空白版本不携带复制源；创建后同步当前版本列表', async () => {
    const wrapper = await manager()
    vi.mocked(createVersion).mockResolvedValue({ ...versions[0], id: 7, name: '空白稿' })
    vi.mocked(listVersions).mockResolvedValue([...versions, { ...versions[0], id: 7, name: '空白稿', binding_count: 0 }])
    await button(wrapper, '创建空白版本').trigger('click')
    await wrapper.get('[data-testid="version-name-input"]').setValue('空白稿')
    await wrapper.get('[data-testid="version-dialog"] form').trigger('submit')
    await flushPromises()
    expect(createVersion).toHaveBeenCalledWith(1, '空白稿', undefined)
    expect(wrapper.text()).toContain('版本已创建')
    expect(wrapper.find('[data-testid="version-dialog"]').exists()).toBe(false)
    expect(wrapper.findAll('.version-item')).toHaveLength(3)
    expect(usePreviewStore().versions.map(v => v.id)).toContain(7)
  })
  it('复制明确使用所选版本作为底稿；重命名不修改绑定', async () => {
    const wrapper = await manager()
    vi.mocked(createVersion).mockResolvedValue({ ...versions[1], id: 7 })
    await wrapper.findAll('.version-item')[1].findAll('button')[1].trigger('click')
    expect((wrapper.get('[data-testid="version-name-input"]').element as HTMLInputElement).value).toBe('研发投递 副本')
    await wrapper.get('[data-testid="version-dialog"] form').trigger('submit')
    await flushPromises()
    expect(createVersion).toHaveBeenCalledWith(1, '研发投递 副本', 6)
    vi.mocked(renameVersion).mockResolvedValue({ ...versions[1], name: '投递新名称' })
    await wrapper.findAll('.version-item')[1].findAll('button')[2].trigger('click')
    await wrapper.get('[data-testid="version-name-input"]').setValue('投递新名称')
    await wrapper.get('[data-testid="version-dialog"] form').trigger('submit')
    await flushPromises()
    expect(renameVersion).toHaveBeenCalledWith(6, '投递新名称')
  })
  it('创建失败保留输入并内联反馈，不误报成功', async () => {
    const wrapper = await manager()
    vi.mocked(createVersion).mockRejectedValue(new Error('版本名称已存在'))
    await button(wrapper, '创建空白版本').trigger('click')
    await wrapper.get('[data-testid="version-name-input"]').setValue('默认版本')
    await wrapper.get('[data-testid="version-dialog"] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid="version-error"]').text()).toContain('版本名称已存在')
    expect((wrapper.get('[data-testid="version-name-input"]').element as HTMLInputElement).value).toBe('默认版本')
  })
  it('删除须二次确认；删除当前版本沿用 store 的切换与保护', async () => {
    const wrapper = await manager()
    const store = usePreviewStore()
    const spy = vi.spyOn(store, 'deleteCurrentVersion').mockResolvedValue({ ok: true, error: null })
    await button(wrapper, '删除版本').trigger('click')
    expect(spy).not.toHaveBeenCalled()
    await button(wrapper, '确认删除').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('最后一个版本不可删除，校对模式下禁止内容版本修改和使用', async () => {
    vi.mocked(listVersions).mockResolvedValue([versions[0]])
    const wrapper = await manager()
    expect(button(wrapper, '删除版本').attributes('disabled')).toBeDefined()
    usePreviewStore().proofreadMode = true
    await flushPromises()
    for (const text of ['使用', '复制', '重命名', '创建空白版本']) expect(button(wrapper, text).attributes('disabled')).toBeDefined()
  })
  it('非当前版本删除失败显示错误，不删除当前预览', async () => {
    const wrapper = await manager()
    vi.mocked(deleteVersion).mockRejectedValue(new Error('删除失败，请重试'))
    const second = wrapper.findAll('.version-item')[1]
    await second.get('.ui-danger').trigger('click')
    await button(wrapper, '确认删除').trigger('click')
    await flushPromises()
    expect(deleteVersion).toHaveBeenCalledWith(6)
    expect(wrapper.get('[role="alert"]').text()).toContain('删除失败，请重试')
    expect(usePreviewStore().currentVersionId).toBe(5)
  })
  it('快速浏览另一模板时丢弃前一个模板的迟到版本响应', async () => {
    let resolveOld!: (value: VersionInfo[]) => void
    vi.mocked(listVersions).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const wrapper = mount(TemplateManager)
    await wrapper.findAll('.template-item')[1].trigger('click')
    await flushPromises()
    resolveOld([{ ...versions[0], name: '旧模板迟到数据' }])
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧模板迟到数据')
    expect(wrapper.find('.version-heading h3').text()).toBe('项目总结.docx')
  })
})
