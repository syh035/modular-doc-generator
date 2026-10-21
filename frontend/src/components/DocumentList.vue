<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiRequestError } from '../api/client'
import { createVersion, type VersionInfo } from '../api/versions'
import { useAppStore } from '../stores/app'
import { useDocumentsStore, type DocumentGroup } from '../stores/documents'
import { usePreviewStore } from '../stores/preview'
import VersionDialog from './VersionDialog.vue'
import DocumentActions from './DocumentActions.vue'

const emit = defineEmits<{ import: [] }>()
const store = useDocumentsStore()
const app = useAppStore()
const preview = usePreviewStore()
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const collapsed = ref<number[]>([])
const creating = ref<DocumentGroup | null>(null)
const saving = ref(false)
const createError = ref<string | null>(null)
const openingId = ref<number | null>(null)
const openError = ref<{ id: number; message: string } | null>(null)
let disposed = false
const busy = computed(() => saving.value || openingId.value !== null || preview.uploadPhase !== 'idle')
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return store.groups.filter(group => app.documentTemplateId === null || group.template.id === app.documentTemplateId).map(group => ({
    group,
    documents: !search || group.template.filename.toLocaleLowerCase().includes(search)
      ? group.documents : group.documents.filter(document => document.name.toLocaleLowerCase().includes(search)),
  })).filter(({ group, documents }) => !search || documents.length > 0
    || group.template.filename.toLocaleLowerCase().includes(search) || group.error || group.loading)
})
function expanded(id: number): boolean { return query.value.trim() !== '' || !collapsed.value.includes(id) }
function toggle(id: number): void {
  collapsed.value = collapsed.value.includes(id) ? collapsed.value.filter(value => value !== id) : [...collapsed.value, id]
}
function newDocument(group: DocumentGroup): void {
  if (busy.value || group.loading || !group.loaded || group.error) return
  createError.value = null
  creating.value = group
}
async function retryGroup(templateId: number, event: MouseEvent): Promise<void> {
  const trigger = event.currentTarget
  await store.loadGroup(templateId)
  await nextTick()
  if (disposed || (document.activeElement !== document.body && document.activeElement !== trigger)) return
  if (trigger instanceof HTMLButtonElement && trigger.isConnected && !trigger.disabled) {
    trigger.focus({ preventScroll: true })
    return
  }
  const heading = document.getElementById(`template-toggle-${templateId}`)
  if (heading instanceof HTMLButtonElement && !heading.disabled) heading.focus({ preventScroll: true })
  else searchInput.value?.focus({ preventScroll: true })
}
async function open(group: DocumentGroup, draft: VersionInfo): Promise<void> {
  if (busy.value) return
  openingId.value = draft.id
  openError.value = null
  preview.dismissMigration()
  try {
    if (preview.currentTemplateId !== group.template.id || preview.currentVersionId !== draft.id
      || preview.proofreadMode || preview.status !== 'ready') {
      // 列表是模板元数据的最新来源，不额外先渲染目标模板的默认稿。
      preview.templates = store.groups.map(item => item.template)
      await preview.selectTemplate(group.template.id, { versionId: draft.id })
    }
    if (disposed || app.activeTab !== 'documents') return
    if (preview.currentTemplateId !== group.template.id || preview.currentVersionId !== draft.id) return
    if (preview.status !== 'ready') throw new Error(preview.error ?? '文稿未能打开，请重试')
    app.setTab('workbench')
  } catch (err) {
    if (!disposed) openError.value = { id: draft.id, message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (!disposed) {
      openingId.value = null
      await nextTick()
      if (!disposed && openError.value?.id === draft.id && document.activeElement === document.body) {
        document.getElementById(`edit-document-${draft.id}`)?.focus({ preventScroll: true })
      }
    }
  }
}
async function create(name: string): Promise<void> {
  const group = creating.value
  if (!group || busy.value) return
  saving.value = true
  createError.value = null
  let document: VersionInfo | null = null
  try {
    document = await createVersion(group.template.id, name)
    store.acceptDocument(document)
    if (!disposed) creating.value = null
  } catch (err) {
    if (!disposed) createError.value = err instanceof ApiRequestError && err.code === 'VERSION_NAME_TAKEN'
      ? '此模板下已有同名文稿，请换一个名称' : err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
  // 落库成功即关闭创建表单；预览失败从列表重试打开，不能再次提交创建。
  if (document && !disposed) {
    query.value = ''
    collapsed.value = collapsed.value.filter(id => id !== group.template.id)
    await open(group, document)
  }
}
function createdDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN')
}
onMounted(() => { void store.load() })
onBeforeUnmount(() => { disposed = true })
</script>

<template>
  <main class="document-list">
    <div class="list-content">
      <header class="list-heading">
        <div>
          <h1>文稿</h1>
          <p>按模板整理，选择一份继续编辑。</p>
        </div>
        <button
          class="ui-btn ui-primary"
          :disabled="busy"
          @click="emit('import')"
        >
          导入模板
        </button>
      </header>
      <div class="list-tools">
        <input
          ref="searchInput"
          v-model="query"
          type="search"
          aria-label="搜索文稿或模板"
          placeholder="搜索文稿或模板"
        >
        <span class="list-count">{{ store.incomplete ? '已加载 ' : '' }}{{ store.documentCount }} 份文稿 · {{ store.groups.length }} 个模板</span>
        <button
          class="ui-btn refresh"
          :disabled="busy || store.loading"
          @click="store.load()"
        >
          {{ store.loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <p
        v-if="app.documentTemplateId !== null"
        class="template-filter"
      >
        仅显示此模板的文稿
        <button
          class="ui-btn"
          @click="app.openTemplateDocuments(null)"
        >
          查看全部文稿
        </button>
      </p>
      <p
        v-if="store.error"
        role="alert"
        class="load-error"
      >
        无法刷新列表：{{ store.error }}。可重试刷新，已加载的文稿仍保留。
      </p>
      <p
        v-if="store.loading && store.groups.length === 0"
        role="status"
        class="empty"
      >
        正在读取模板和文稿…
      </p>
      <section
        v-for="{ group, documents } in filtered"
        :key="group.template.id"
        class="template-group"
        :aria-label="group.template.filename"
      >
        <div class="group-heading">
          <button
            :id="`template-toggle-${group.template.id}`"
            class="group-toggle"
            :aria-expanded="expanded(group.template.id)"
            :aria-controls="`template-documents-${group.template.id}`"
            :disabled="!!query.trim()"
            @click="toggle(group.template.id)"
          >
            <span
              class="chevron"
              aria-hidden="true"
            >{{ expanded(group.template.id) ? '⌄' : '›' }}</span>
            <span class="group-name">{{ group.template.filename }}</span>
            <span class="group-count">{{ group.loaded ? `${group.documents.length} 份文稿` : group.loading ? '加载中…' : '未加载' }}</span>
          </button>
          <button
            class="ui-btn new-document"
            :aria-label="`在${group.template.filename}中新建文稿`"
            :disabled="busy || group.loading || !group.loaded || !!group.error"
            @click="newDocument(group)"
          >
            ＋ 新建文稿
          </button>
        </div>
        <div
          v-show="expanded(group.template.id)"
          :id="`template-documents-${group.template.id}`"
          class="group-documents"
        >
          <div
            v-if="group.error"
            role="alert"
            class="group-error"
          >
            <span>文稿未能更新：{{ group.error }}{{ group.loaded ? '（下方保留上次结果）' : '' }}</span>
            <button
              :disabled="busy || group.loading"
              class="ui-btn"
              :aria-label="`重试读取${group.template.filename}的文稿`"
              @click="retryGroup(group.template.id, $event)"
            >
              重试
            </button>
          </div>
          <p
            v-else-if="group.loading && !group.loaded"
            class="group-empty"
            role="status"
          >
            正在读取文稿…
          </p>
          <p
            v-else-if="group.loaded && !group.loading && group.documents.length === 0"
            class="group-empty"
          >
            还没有文稿，点击“新建文稿”开始填写。
          </p>
          <article
            v-for="document in documents"
            :key="document.id"
            class="document-row"
            :aria-label="document.name"
          >
            <div class="document-info">
              <strong>{{ document.name }}</strong>
              <span
                v-if="document.id === preview.currentVersionId && preview.status === 'ready'"
                class="current"
              >当前文稿</span>
              <p v-if="createdDate(document.created_at)">
                创建于 {{ createdDate(document.created_at) }}
              </p>
              <p
                v-if="openError?.id === document.id"
                role="alert"
                class="open-error"
              >
                {{ openError.message }}
              </p>
            </div>
            <button
              :id="`edit-document-${document.id}`"
              class="ui-btn edit-document"
              :aria-label="`编辑${document.name}`"
              :disabled="busy"
              @click="open(group, document)"
            >
              {{ openingId === document.id ? '打开中…' : '继续编辑' }}
            </button>
            <DocumentActions
              compact
              :document="document"
              :can-delete="group.documents.length > 1"
              :disabled="busy || !!group.error"
              @open="open(group, $event)"
            />
          </article>
        </div>
      </section>
      <div
        v-if="!store.loading && !store.error && store.groups.length === 0"
        class="empty"
      >
        <h2>从一份 Word 模板开始</h2>
        <p>导入 .docx 模板后，文稿会按模板显示在这里。</p>
      </div>
      <p
        v-else-if="query.trim() && filtered.length === 0"
        class="empty"
        role="status"
      >
        没有找到对应的文稿或模板，试试其他名称。
      </p>
    </div>
    <VersionDialog
      v-if="creating"
      subject="document"
      mode="create"
      copy-mode="blank"
      initial-name=""
      :can-copy="false"
      :error="createError"
      :submitting="saving"
      @submit="create"
      @close="creating = null"
    />
  </main>
</template>

<style scoped>
.document-list { flex: 1; min-height: 0; overflow: auto; padding: 32px 24px 48px; }
.list-content { width: min(100%, 1000px); margin: 0 auto; }
.list-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 24px; }
h1 { font-size: 24px; letter-spacing: .02em; }
.list-heading p { margin-top: 8px; color: var(--text-2); font-size: 13px; }
.list-tools { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.list-tools input { flex: 1; max-width: 400px; }
.list-count { color: var(--text-2); font-size: 12px; margin-left: auto; }
.template-filter { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; color: var(--text-2); font-size: 13px; }
.refresh { border-color: transparent; color: var(--text-2); }
.template-group { margin-bottom: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-surface); }
.group-heading { display: flex; align-items: center; gap: 16px; padding: 14px 20px; }
.group-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; border: 0; padding: 4px 0; text-align: left; background: transparent; }
.group-toggle:disabled { cursor: default; opacity: 1; color: inherit; }
.chevron { font-size: 22px; width: 14px; flex-shrink: 0; color: var(--text-3); }
.group-name { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.group-count { color: var(--text-2); font-size: 12px; white-space: nowrap; }
.new-document { flex-shrink: 0; color: var(--primary); border-color: var(--border); }
.group-documents { border-top: 1px solid var(--border-subtle); padding: 0 20px 0 46px; }
.document-row { display: flex; align-items: center; gap: 16px; padding: 17px 0; }
.document-row + .document-row { border-top: 1px solid var(--border-subtle); }
.document-info { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.document-info strong { font-size: 14px; font-weight: 500; }
.document-info p { margin-top: 6px; font-size: 12px; color: var(--text-3); }
.current { margin-left: 10px; font-size: 11px; color: var(--primary); }
.edit-document { flex-shrink: 0; border-color: transparent; color: var(--primary); }
.group-empty { padding: 22px 0; font-size: 13px; color: var(--text-2); }
.group-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; font-size: 13px; color: var(--danger); overflow-wrap: anywhere; }
.load-error { padding: 12px 16px; margin-bottom: 20px; border-radius: 8px; background: var(--danger-bg-subtle); color: var(--danger); overflow-wrap: anywhere; }
.document-info .open-error { color: var(--danger); }
.empty { padding: 48px 16px; text-align: center; color: var(--text-2); }
.empty h2 { margin-bottom: 12px; color: var(--text-1); font-size: 18px; }
@media (max-width: 600px) {
  .document-list { padding: 20px 12px 32px; }
  .list-heading { align-items: flex-start; gap: 12px; margin-bottom: 20px; }
  .list-heading p { max-width: 170px; line-height: 1.6; }
  .list-tools { flex-wrap: wrap; gap: 8px; }
  .list-tools input { flex-basis: 100%; max-width: none; }
  .list-count { margin-left: 0; margin-right: auto; }
  .group-heading { padding: 14px 12px; gap: 8px; flex-wrap: wrap; }
  .group-toggle { flex-basis: 100%; gap: 8px; }
  .group-count { margin-left: auto; }
  .new-document { margin-left: 22px; }
  .group-documents { padding: 0 12px 0 34px; }
  .document-row { gap: 8px; }
  .edit-document { padding: 7px 4px; }
  .current { display: block; margin: 4px 0 0; }
  .group-error { align-items: flex-start; }
}
</style>
