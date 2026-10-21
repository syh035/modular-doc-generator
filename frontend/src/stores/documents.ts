/** 文稿列表视图模型；沿用 versions.id，不在读取时创建或清理旧稿。 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { listTemplates, type TemplateListItem } from '../api/templates'
import { listVersions, type VersionInfo } from '../api/versions'

export interface DocumentGroup {
  template: TemplateListItem
  documents: VersionInfo[]
  loading: boolean
  error: string | null
  loaded: boolean
}

export const useDocumentsStore = defineStore('documents', () => {
  const groups = ref<DocumentGroup[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const documentCount = computed(() => groups.value.reduce((sum, group) => sum + group.documents.length, 0))
  const incomplete = computed(() => error.value !== null || groups.value.some(group => !group.loaded || group.error !== null))
  let request = 0
  const groupRequests = new Map<number, number>()

  async function loadGroup(templateId: number, generation = request): Promise<void> {
    const group = groups.value.find(item => item.template.id === templateId)
    if (!group || generation !== request) return
    const seq = (groupRequests.get(templateId) ?? 0) + 1
    groupRequests.set(templateId, seq)
    group.loading = true
    group.error = null
    const current = () => generation === request && groupRequests.get(templateId) === seq
    try {
      const documents = await listVersions(templateId)
      if (current()) {
        group.documents = documents
        group.loaded = true
      }
    } catch (err) {
      if (current()) group.error = err instanceof Error ? err.message : String(err)
    } finally {
      if (current()) group.loading = false
    }
  }

  async function load(): Promise<void> {
    const seq = ++request
    loading.value = true
    error.value = null
    groups.value.forEach(group => { group.loading = false })
    try {
      const templates = await listTemplates()
      if (seq !== request) return
      const previous = new Map(groups.value.map(group => [group.template.id, group]))
      groups.value = templates.map(template => ({
        template, documents: previous.get(template.id)?.documents ?? [],
        loaded: previous.get(template.id)?.loaded ?? false, loading: true, error: null,
      }))
      // 限制本地服务并发；单组失败不吞掉其他模板和已加载的旧稿。
      const pending = [...templates]
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length > 0 && seq === request) {
          const template = pending.shift()!
          await loadGroup(template.id, seq)
        }
      }))
    } catch (err) {
      if (seq === request) error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (seq === request) loading.value = false
    }
  }

  function acceptDocument(document: VersionInfo): void {
    const group = groups.value.find(item => item.template.id === document.template_id)
    if (!group) return
    // 新建完成时隔离较早的列表响应，避免刚创建的文稿被旧列表覆盖。
    groupRequests.set(document.template_id, (groupRequests.get(document.template_id) ?? 0) + 1)
    group.loading = false
    group.documents = [...group.documents.filter(item => item.id !== document.id), document]
  }

  return { groups, loading, error, documentCount, incomplete, load, loadGroup, acceptDocument }
})
