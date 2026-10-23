import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listTemplates, type TemplateListItem } from '../api/templates'
import { listVersions, type VersionInfo } from '../api/versions'
import { useDocumentsStore } from './documents'

vi.mock('../api/templates', () => ({ listTemplates: vi.fn() }))
vi.mock('../api/versions', () => ({ listVersions: vi.fn() }))
const templates = vi.mocked(listTemplates)
const versions = vi.mocked(listVersions)
const template = (id: number) => ({ id, filename: `模板${id}.docx` }) as TemplateListItem
const document = (id: number, templateId = 1) => ({ id, template_id: templateId, name: `文稿${id}` }) as VersionInfo
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

beforeEach(() => { setActivePinia(createPinia()); vi.resetAllMocks() })

describe('按模板分组的文稿视图模型', () => {
  it('保留旧默认稿、同名不同 ID 的模板和零文稿模板，读取不产生写请求', async () => {
    templates.mockResolvedValue([template(1), { ...template(2), filename: '模板1.docx' }])
    versions.mockImplementation(async id => id === 1 ? [document(11), { ...document(12), name: '默认版本' }] : [])
    const store = useDocumentsStore()
    await store.load()
    expect(store.groups.map(group => [group.template.id, group.documents.map(item => item.id)])).toEqual([[1, [11, 12]], [2, []]])
    expect(store.documentCount).toBe(2)
    expect(store.incomplete).toBe(false)
    expect(versions.mock.calls.map(call => call[0])).toEqual([1, 2])
  })

  it('单组失败保留其他文稿与旧数据，重试只请求该模板', async () => {
    templates.mockResolvedValue([template(1), template(2)])
    versions.mockResolvedValue([document(11)])
    const store = useDocumentsStore()
    await store.load()
    versions.mockImplementation(async id => {
      if (id === 1) throw new Error('读取文稿失败')
      return []
    })
    await store.load()
    expect(store.groups[0]?.documents.map(item => item.id)).toEqual([11])
    expect(store.groups[0]?.error).toBe('读取文稿失败')
    expect(store.groups[1]?.loaded).toBe(true)
    expect(store.incomplete).toBe(true)
    versions.mockResolvedValue([document(12)])
    versions.mockClear()
    await store.loadGroup(1)
    expect(versions.mock.calls).toEqual([[1]])
    expect(store.groups[0]?.documents.map(item => item.id)).toEqual([12])
    expect(store.incomplete).toBe(false)
  })

  it('总列表失败时保留可用文稿并结束被旧请求遗留的加载状态', async () => {
    templates.mockResolvedValue([template(1)])
    versions.mockResolvedValue([document(11)])
    const store = useDocumentsStore()
    await store.load()
    const old = deferred<VersionInfo[]>()
    versions.mockReturnValue(old.promise)
    const first = store.load()
    await flushPromises()
    templates.mockRejectedValue(new Error('服务离线'))
    await store.load()
    old.resolve([document(99)])
    await first
    expect(store.error).toBe('服务离线')
    expect(store.groups[0]?.documents.map(item => item.id)).toEqual([11])
    expect(store.groups[0]?.loading).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('较早的模板列表和文稿响应都不能覆盖新一轮刷新', async () => {
    const oldTemplates = deferred<TemplateListItem[]>()
    templates.mockReturnValueOnce(oldTemplates.promise).mockResolvedValue([template(2)])
    versions.mockResolvedValue([document(22, 2)])
    const store = useDocumentsStore()
    const first = store.load()
    await store.load()
    oldTemplates.resolve([template(1)])
    await first
    expect(store.groups.map(group => group.template.id)).toEqual([2])
    const oldDocuments = deferred<VersionInfo[]>()
    versions.mockReturnValueOnce(oldDocuments.promise).mockResolvedValue([document(23, 2)])
    const second = store.loadGroup(2)
    await store.loadGroup(2)
    oldDocuments.resolve([document(99, 2)])
    await second
    expect(store.groups[0]?.documents.map(item => item.id)).toEqual([23])
  })

  it('创建成功立即接纳新 ID，旧列表不能将其抹掉', async () => {
    templates.mockResolvedValue([template(1)])
    versions.mockResolvedValue([document(11)])
    const store = useDocumentsStore()
    await store.load()
    const old = deferred<VersionInfo[]>()
    versions.mockReturnValue(old.promise)
    const pending = store.loadGroup(1)
    store.acceptDocument(document(12))
    old.resolve([document(11)])
    await pending
    expect(store.groups[0]?.documents.map(item => item.id)).toEqual([11, 12])
    expect(store.groups[0]?.loading).toBe(false)
  })

  it('同时最多四组请求，刷新时不继续派发过期队列', async () => {
    templates.mockResolvedValue(Array.from({ length: 9 }, (_, index) => template(index + 1)))
    const responses = Array.from({ length: 4 }, () => deferred<VersionInfo[]>())
    versions.mockImplementation(id => responses[id - 1]!.promise)
    const store = useDocumentsStore()
    const first = store.load()
    await flushPromises()
    expect(versions).toHaveBeenCalledTimes(4)
    templates.mockResolvedValue([])
    await store.load()
    responses.forEach(response => response.resolve([]))
    await first
    expect(versions).toHaveBeenCalledTimes(4)
    expect(store.groups).toEqual([])
  })
})
