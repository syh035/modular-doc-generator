import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listTemplates, type TemplateListItem } from '../api/templates'
import { createVersion, listVersions, type VersionInfo } from '../api/versions'
import { useAppStore } from '../stores/app'
import { useDocumentsStore } from '../stores/documents'
import { usePreviewStore } from '../stores/preview'
import DocumentList from './DocumentList.vue'

vi.mock('../api/templates', async importOriginal => ({ ...await importOriginal<typeof import('../api/templates')>(), listTemplates: vi.fn() }))
vi.mock('../api/versions', async importOriginal => ({ ...await importOriginal<typeof import('../api/versions')>(), listVersions: vi.fn(), createVersion: vi.fn() }))
const template = (id: number, filename: string) => ({ id, filename }) as TemplateListItem
const draft = (id: number, name = '投递稿', templateId = 1): VersionInfo => ({
  id, name, template_id: templateId, binding_count: 0, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
})
const wrappers: VueWrapper[] = []
const list = () => {
  const wrapper = mount(DocumentList, { global: { plugins: [createPinia()] }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
function stubOpen() {
  const preview = usePreviewStore()
  return vi.spyOn(preview, 'selectTemplate').mockImplementation(async (id, options) => {
    preview.currentTemplateId = id; preview.currentVersionId = options?.versionId ?? null
    preview.status = 'ready'
  })
}
beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  vi.mocked(listTemplates).mockResolvedValue([template(1, '通用模板.docx'), template(2, '项目模板.docx')])
  vi.mocked(listVersions).mockImplementation(async id => id === 1 ? [draft(11), draft(12, '默认版本')] : [])
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

describe('文稿分组列表', () => {
  it('按模板列出旧稿和空模板，组可折叠，搜索文稿或模板会展开命中组', async () => {
    const wrapper = list()
    await flushPromises()
    expect(wrapper.findAll('.template-group')).toHaveLength(2)
    expect(wrapper.text()).toContain('默认版本')
    expect(wrapper.text()).toContain('还没有文稿')
    expect(wrapper.text()).not.toContain('最近编辑')
    await wrapper.findAll('.group-toggle')[0]!.trigger('click')
    expect(wrapper.findAll('.group-documents')[0]!.isVisible()).toBe(false)
    await wrapper.get('[type=search]').setValue('投递')
    expect(wrapper.findAll('.template-group')).toHaveLength(1)
    expect(wrapper.findAll('.document-row')).toHaveLength(1)
    expect(wrapper.get('.group-documents').isVisible()).toBe(true)
    await wrapper.get('[type=search]').setValue('项目模板')
    expect(wrapper.findAll('.template-group')).toHaveLength(1)
    expect(wrapper.text()).toContain('还没有文稿')
    await wrapper.get('[type=search]').setValue('不存在的稿件')
    expect(wrapper.text()).toContain('没有找到')
  })

  it('直接打开指定 ID，成功才进入编辑页，不写入任何文稿', async () => {
    const wrapper = list()
    await flushPromises()
    const open = stubOpen()
    await wrapper.findAll('.edit-document')[1]!.trigger('click')
    await flushPromises()
    expect(open).toHaveBeenCalledExactlyOnceWith(1, { versionId: 12 })
    expect(useAppStore().activeTab).toBe('workbench')
    expect(createVersion).not.toHaveBeenCalled()
  })

  it('再次打开当前稿保留预览与未提交编辑，不重复转换且清除旧迁移提示', async () => {
    const wrapper = list()
    await flushPromises()
    const preview = usePreviewStore()
    preview.currentTemplateId = 1; preview.currentVersionId = 11; preview.status = 'ready'
    preview.migrationSource = { sourceVersionId: 9, sourceVersionName: '原稿', sourceTemplateName: '旧模板', sourceBindingCount: 1 }
    const open = stubOpen()
    await wrapper.findAll('.edit-document')[0]!.trigger('click')
    expect(open).not.toHaveBeenCalled()
    expect(preview.migrationSource).toBeNull()
    expect(useAppStore().activeTab).toBe('workbench')
  })

  it('零文稿模板可新建，POST 成功后立即打开新 ID，名称保留且无复制来源', async () => {
    const wrapper = list()
    await flushPromises()
    const open = stubOpen()
    vi.mocked(createVersion).mockResolvedValue(draft(23, '项目岗位', 2))
    await wrapper.findAll('.new-document')[1]!.trigger('click')
    expect(wrapper.get('dialog').attributes('aria-label')).toBe('文稿')
    expect(wrapper.text()).toContain('保留模板原文和版式')
    await wrapper.get('[data-testid=version-name-input]').setValue(' 项目岗位 ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(createVersion).toHaveBeenCalledExactlyOnceWith(2, '项目岗位')
    expect(useDocumentsStore().groups[1]?.documents.map(item => item.id)).toEqual([23])
    expect(open).toHaveBeenCalledExactlyOnceWith(2, { versionId: 23 })
    expect(useAppStore().activeTab).toBe('workbench')
  })

  it('创建成功但预览失败时保留新稿，仅重试打开，不重复创建', async () => {
    const wrapper = list()
    await flushPromises()
    vi.mocked(createVersion).mockResolvedValue(draft(13, '新文稿'))
    const open = vi.spyOn(usePreviewStore(), 'selectTemplate').mockImplementation(async (id, options) => {
      const preview = usePreviewStore()
      preview.currentTemplateId = id; preview.currentVersionId = options?.versionId ?? null
      preview.status = 'error'; preview.error = '转换暂时失败'
    })
    await wrapper.findAll('.new-document')[0]!.trigger('click')
    await wrapper.get('[data-testid=version-name-input]').setValue('新文稿')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('dialog').exists()).toBe(false)
    expect(wrapper.get('[role=alert]').text()).toContain('转换暂时失败')
    expect(wrapper.find('.current').exists()).toBe(false)
    expect(document.activeElement?.id).toBe('edit-document-13')
    expect(useAppStore().activeTab).toBe('documents')
    open.mockImplementation(async (id, options) => {
      const preview = usePreviewStore()
      preview.currentTemplateId = id; preview.currentVersionId = options?.versionId ?? null; preview.status = 'ready'
    })
    await wrapper.findAll('.edit-document')[2]!.trigger('click')
    expect(createVersion).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(2)
    expect(useAppStore().activeTab).toBe('workbench')
  })

  it('请求中禁止重复创建和取消；失败保留名称及错误供重试', async () => {
    const wrapper = list()
    await flushPromises()
    let reject!: (reason: Error) => void
    vi.mocked(createVersion).mockReturnValue(new Promise((_, fail) => { reject = fail }))
    await wrapper.findAll('.new-document')[0]!.trigger('click')
    await wrapper.get('[data-testid=version-name-input]').setValue('保留草稿名')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('dialog [aria-label=关闭]').trigger('click')
    expect(wrapper.find('dialog').exists()).toBe(true)
    expect(createVersion).toHaveBeenCalledTimes(1)
    reject(new Error('创建失败'))
    await flushPromises()
    expect(wrapper.get('[data-testid=version-name-input]').element).toHaveProperty('value', '保留草稿名')
    expect(wrapper.get('[data-testid=version-error]').text()).toBe('创建失败')
    expect(document.activeElement).toBe(wrapper.get('[data-testid=version-name-input]').element)
  })

  it('局部失败可单组重试，不能显示为空模板或隐藏其他模板的结果', async () => {
    vi.mocked(listVersions).mockImplementation(async id => {
      if (id === 2) throw new Error('读取失败')
      return [draft(11)]
    })
    const wrapper = list()
    await flushPromises()
    expect(wrapper.findAll('.template-group')).toHaveLength(2)
    expect(wrapper.text()).toContain('投递稿')
    expect(wrapper.text()).not.toContain('还没有文稿')
    expect(wrapper.get('[role=alert]').text()).toContain('读取失败')
    expect(wrapper.findAll('.new-document')[1]!.attributes('disabled')).toBeDefined()
    vi.mocked(listVersions).mockResolvedValue([])
    ;(wrapper.get('.group-error button').element as HTMLButtonElement).focus()
    await wrapper.get('.group-error button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role=alert]').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有文稿')
    expect(document.activeElement?.id).toBe('template-toggle-2')
  })

  it('重试期间用户移到搜索框，完成后不抢回焦点', async () => {
    vi.mocked(listVersions).mockRejectedValue(new Error('读取失败'))
    const wrapper = list()
    await flushPromises()
    let resolve!: (documents: VersionInfo[]) => void
    vi.mocked(listVersions).mockReturnValue(new Promise(complete => { resolve = complete }))
    await wrapper.findAll('.group-error button')[0]!.trigger('click')
    ;(wrapper.get('[type=search]').element as HTMLInputElement).focus()
    resolve([])
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[type=search]').element)
  })

  it('离开列表后的旧打开请求不抢回页面', async () => {
    const wrapper = list()
    await flushPromises()
    let resolve!: () => void
    const preview = usePreviewStore()
    vi.spyOn(preview, 'selectTemplate').mockImplementation(() => new Promise(complete => { resolve = complete }))
    await wrapper.findAll('.edit-document')[0]!.trigger('click')
    wrapper.unmount()
    useAppStore().setTab('guide')
    preview.currentTemplateId = 1; preview.currentVersionId = 11; preview.status = 'ready'
    resolve()
    await flushPromises()
    expect(useAppStore().activeTab).toBe('guide')
  })

  it('无模板时显示导入说明，导入按钮交给统一的文件选择入口', async () => {
    vi.mocked(listTemplates).mockResolvedValue([])
    const wrapper = list()
    await flushPromises()
    expect(wrapper.text()).toContain('从一份 Word 模板开始')
    await wrapper.get('.list-heading button').trigger('click')
    expect(wrapper.emitted('import')).toHaveLength(1)
    expect(createVersion).not.toHaveBeenCalled()
  })
})
