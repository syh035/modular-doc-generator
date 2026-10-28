import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVersion, deleteVersion, renameVersion, type VersionInfo } from '../api/versions'
import type { TemplateListItem } from '../api/templates'
import { useAppStore } from '../stores/app'
import { useDocumentsStore } from '../stores/documents'
import { usePreviewStore } from '../stores/preview'
import DocumentActions from './DocumentActions.vue'

vi.mock('../api/versions', async importOriginal => ({ ...await importOriginal<typeof import('../api/versions')>(),
  createVersion: vi.fn(), deleteVersion: vi.fn(), renameVersion: vi.fn(),
}))
const draft = (id: number, name = '原稿'): VersionInfo => ({ id, template_id: 1, name, binding_count: 1, created_at: '', updated_at: '' })
const wrappers: VueWrapper[] = []
function actions(canDelete = true) {
  const wrapper = mount(DocumentActions, { props: { document: draft(11), canDelete }, attachTo: document.body })
  wrappers.push(wrapper)
  return wrapper
}
async function choose(wrapper: VueWrapper, label: string): Promise<void> {
  const menu = wrapper.get<HTMLDetailsElement>('details')
  menu.element.open = true
  await menu.trigger('toggle')
  await wrapper.findAll('.action-menu button').find(button => button.text() === label)!.trigger('click')
}
beforeEach(() => {
  vi.resetAllMocks(); setActivePinia(createPinia())
  const preview = usePreviewStore()
  preview.currentTemplateId = 1; preview.currentVersionId = 11; preview.status = 'ready'; preview.versions = [draft(11), draft(12, '其他稿')]
  useDocumentsStore().groups = [{ template: { id: 1, filename: '模板.docx' } as TemplateListItem, documents: [draft(11), draft(12, '其他稿')], loaded: true, loading: false, error: null }]
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })

describe('文稿操作与原稿保护', () => {
  it('重命名同步列表及当前标题，保持分组顺序，不重新渲染 PDF', async () => {
    vi.mocked(renameVersion).mockResolvedValue(draft(11, '新名称'))
    const wrapper = actions()
    const select = vi.spyOn(usePreviewStore(), 'selectTemplate')
    await choose(wrapper, '重命名文稿')
    await wrapper.get('[data-testid=version-name-input]').setValue(' 新名称 ')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(renameVersion).toHaveBeenCalledExactlyOnceWith(11, '新名称')
    expect(usePreviewStore().versions[0]?.name).toBe('新名称')
    expect(useDocumentsStore().groups[0]?.documents.map(document => document.id)).toEqual([11, 12])
    expect(useDocumentsStore().groups[0]?.documents[0]?.name).toBe('新名称')
    expect(select).not.toHaveBeenCalled()
  })

  it('另存复制明确的源 ID，成功后才发出打开新稿事件，原稿不变', async () => {
    vi.mocked(createVersion).mockResolvedValue(draft(21, '投递稿'))
    const wrapper = actions()
    await choose(wrapper, '另存为文稿')
    expect(wrapper.text()).toContain('已保存内容和排版')
    await wrapper.get('[data-testid=version-name-input]').setValue('投递稿')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(createVersion).toHaveBeenCalledExactlyOnceWith(1, '投递稿', 11)
    expect(wrapper.emitted('open')).toEqual([[draft(21, '投递稿')]])
    expect(useDocumentsStore().groups[0]?.documents.map(document => document.name)).toEqual(['原稿', '其他稿', '投递稿'])
    expect(usePreviewStore().currentVersionId).toBe(11)
  })

  it('复制失败保留名称和原稿，不发出打开事件', async () => {
    vi.mocked(createVersion).mockRejectedValue(new Error('暂时不能保存'))
    const wrapper = actions()
    await choose(wrapper, '另存为文稿')
    await wrapper.get('[data-testid=version-name-input]').setValue('保留这个名称')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid=version-name-input]').element).toHaveProperty('value', '保留这个名称')
    expect(wrapper.get('[role=alert]').text()).toBe('暂时不能保存')
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(useDocumentsStore().documentCount).toBe(2)
  })

  it('删除前独立确认，可取消；删除当前稿后回到列表并清空编辑上下文', async () => {
    vi.mocked(deleteVersion).mockResolvedValue(undefined)
    const preview = usePreviewStore()
    const clear = vi.spyOn(preview, 'selectTemplate').mockImplementation(async () => { preview.currentTemplateId = null; preview.currentVersionId = null })
    useAppStore().setTab('workbench')
    const wrapper = actions()
    await choose(wrapper, '删除文稿')
    expect(deleteVersion).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('已有归档保留')
    await wrapper.get('dialog button').trigger('click')
    expect(wrapper.find('dialog').exists()).toBe(false)
    await choose(wrapper, '删除文稿')
    await wrapper.findAll('dialog button')[1]!.trigger('click')
    await flushPromises()
    expect(deleteVersion).toHaveBeenCalledExactlyOnceWith(11, true)
    expect(useDocumentsStore().groups[0]?.documents.map(document => document.id)).toEqual([12])
    expect(clear).toHaveBeenCalledExactlyOnceWith(null)
    expect(useAppStore().activeTab).toBe('documents')
    expect(preview.currentVersionId).toBeNull()
  })

  it('删除其他稿不改变当前正在编辑的稿件，失败时保留记录和确认窗口', async () => {
    usePreviewStore().currentVersionId = 12
    vi.mocked(deleteVersion).mockRejectedValue(new Error('删除失败'))
    const wrapper = actions()
    await choose(wrapper, '删除文稿')
    await wrapper.findAll('dialog button')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toBe('删除失败')
    expect(useDocumentsStore().documentCount).toBe(2)
    vi.mocked(deleteVersion).mockResolvedValue(undefined)
    await wrapper.findAll('dialog button')[1]!.trigger('click')
    await flushPromises()
    expect(usePreviewStore().currentVersionId).toBe(12)
    expect(useDocumentsStore().documentCount).toBe(1)
  })

  it('操作不可用时禁止删除，菜单 Escape 关闭后归还焦点', async () => {
    const wrapper = actions(false)
    const menu = wrapper.get<HTMLDetailsElement>('details')
    menu.element.open = true
    await menu.trigger('toggle')
    const remove = wrapper.findAll('.action-menu button').find(button => button.text() === '删除文稿')!
    expect(remove.attributes('disabled')).toBeDefined()
    ;(wrapper.get('.action-menu button').element as HTMLButtonElement).focus()
    await menu.trigger('keydown', { key: 'Escape' })
    expect(menu.element.open).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('summary').element)
    expect(deleteVersion).not.toHaveBeenCalled()
  })

  it('离开页面后的复制结果保留新稿，不抢回当前页面或切换别的稿件', async () => {
    let resolve!: (document: VersionInfo) => void
    vi.mocked(createVersion).mockReturnValue(new Promise(complete => { resolve = complete }))
    const wrapper = actions()
    await choose(wrapper, '另存为文稿')
    await wrapper.get('form').trigger('submit')
    wrapper.unmount()
    useAppStore().setTab('guide'); usePreviewStore().currentVersionId = 12
    resolve(draft(21, '副本'))
    await flushPromises()
    expect(useDocumentsStore().documentCount).toBe(3)
    expect(useAppStore().activeTab).toBe('guide')
    expect(usePreviewStore().currentVersionId).toBe(12)
    expect(wrapper.emitted('open')).toBeUndefined()
  })
})
