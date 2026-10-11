<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { createVersion, deleteVersion, listVersions, renameVersion, type VersionInfo } from '../api/versions'
import { usePreviewStore } from '../stores/preview'
import { useModalEsc } from '../composables/useModalEsc'
import VersionDialog from './VersionDialog.vue'

const emit = defineEmits<{ close: []; use: [templateId: number, versionId: number | null]; import: [] }>()
const store = usePreviewStore()
const query = ref('')
const selectedId = ref(store.currentTemplateId ?? store.templates[0]?.id ?? null)
const versions = ref<VersionInfo[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const notice = ref('')
const checkedIds = ref<number[]>([])
const batchMode = ref(false)
const deleteTargets = ref<number[]>([])
const deleteResult = ref('')
const deletingId = ref<number | null>(null)
const editor = ref<{ mode: 'create' | 'rename'; source: VersionInfo | null; copy: boolean } | null>(null)
const editorError = ref<string | null>(null)
let request = 0
const templates = computed(() => store.templates
  .filter(t => t.filename.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))
  .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')))
const selected = computed(() => store.templates.find(t => t.id === selectedId.value))
const deleteNames = computed(() => store.templates.filter(t => deleteTargets.value.includes(t.id)).slice(0, 3).map(t => t.filename).join('、'))
const allChecked = computed(() => templates.value.length > 0 && templates.value.every(t => checkedIds.value.includes(t.id)))
watch(query, () => { checkedIds.value = []; deleteTargets.value = [] })
function toggleBatch(): void {
  batchMode.value = !batchMode.value
  checkedIds.value = []
  deleteTargets.value = []
}
function check(id: number): void {
  deleteTargets.value = []
  checkedIds.value = checkedIds.value.includes(id) ? checkedIds.value.filter(n => n !== id) : [...checkedIds.value, id]
}
function selectAll(): void { deleteTargets.value = []; checkedIds.value = allChecked.value ? [] : templates.value.map(t => t.id) }
async function removeTemplates(): Promise<void> {
  if (busy.value || deleteTargets.value.length === 0) return
  busy.value = true
  const targets = store.templates.filter(t => deleteTargets.value.includes(t.id))
  const failedIds: number[] = []
  const failures: string[] = []
  for (const t of targets) {
    const result = await store.removeTemplate(t.id)
    if (!result.ok) { failedIds.push(t.id); failures.push(`${t.filename}：${result.error}`) }
  }
  checkedIds.value = failedIds
  deleteTargets.value = []
  if (!store.templates.some(t => t.id === selectedId.value)) selectedId.value = store.templates[0]?.id ?? null
  deleteResult.value = `已删除 ${targets.length - failedIds.length} 个模板${failures.length ? `；未删除：${failures.join('；')}` : ''}`
  busy.value = false
  await nextTick()
  managerModal.value?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus({ preventScroll: true })
}

function date(value: string): string {
  return value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

async function load(): Promise<void> {
  const seq = ++request
  const id = selectedId.value
  versions.value = []
  error.value = null
  deletingId.value = null
  notice.value = ''
  loading.value = id !== null
  if (id === null) return
  try {
    const result = await listVersions(id)
    if (seq === request) versions.value = result
  } catch (err) {
    if (seq === request) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (seq === request) loading.value = false
  }
}
watch(selectedId, () => { void load() }, { immediate: true })
onBeforeUnmount(() => { request++ })

function edit(mode: 'create' | 'rename', source: VersionInfo | null = null, copy = false): void {
  notice.value = ''
  editorError.value = null
  editor.value = { mode, source, copy }
}

async function save(name: string): Promise<void> {
  const action = editor.value
  const templateId = selectedId.value
  if (!action || templateId === null || busy.value) return
  busy.value = true
  editorError.value = null
  try {
    if (action.mode === 'rename' && action.source) await renameVersion(action.source.id, name)
    else await createVersion(templateId, name, action.copy ? action.source?.id : undefined)
    editor.value = null
    await load()
    if (templateId === store.currentTemplateId) await store.loadVersionList()
    notice.value = action.mode === 'rename' ? '版本名称已更新' : '版本已创建，点击“使用”打开'
  } catch (err) {
    editorError.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    await nextTick()
    if (!editor.value) managerModal.value?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus({ preventScroll: true })
  }
}

async function remove(version: VersionInfo): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  notice.value = ''
  try {
    if (version.id === store.currentVersionId) {
      const result = await store.deleteCurrentVersion()
      if (!result.ok) throw new Error(result.error ?? '删除失败')
    } else {
      await deleteVersion(version.id)
      if (selectedId.value === store.currentTemplateId) await store.loadVersionList()
    }
    await load()
    notice.value = '版本已删除'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
    deletingId.value = null
    await nextTick()
    managerModal.value?.querySelector<HTMLElement>('[data-modal-autofocus]')?.focus({ preventScroll: true })
  }
}
const managerModal = useModalEsc(() => { if (!busy.value) emit('close') })
</script>

<template>
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="模板与版本管理"
    @click.self="!busy && emit('close')"
  >
    <section class="manager-card">
      <header class="manager-head">
        <div><h2>模板与版本</h2><p>选择版式，管理该模板下的内容组合</p></div>
        <button
          class="icon-btn"
          aria-label="关闭模板管理"
          :disabled="busy"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="manager-body">
        <aside class="template-list">
          <label class="search-label">查找模板<input
            v-model="query"
            data-modal-autofocus
            type="search"
            placeholder="搜索模板名称"
            :disabled="busy"
          ></label>
          <div class="list-heading">
            <span>{{ templates.length }} 个模板 · 最近更新</span><button
              class="ui-btn"
              :disabled="busy"
              @click="emit('import')"
            >
              导入模板
            </button>
          </div>
          <p
            v-if="store.templatesError"
            class="error"
          >
            {{ store.templatesError }}
          </p>
          <div class="template-items">
            <div class="batch-bar">
              <button
                class="ui-btn"
                :disabled="busy || store.proofreadMode"
                @click="toggleBatch"
              >
                {{ batchMode ? '退出批量' : '批量管理' }}
              </button>
              <template v-if="batchMode">
                <label><input
                  type="checkbox"
                  aria-label="全选当前模板列表"
                  :checked="allChecked"
                  :indeterminate="checkedIds.length > 0 && !allChecked"
                  :disabled="busy || templates.length === 0"
                  @change="selectAll"
                >全选当前列表</label>
                <button
                  class="ui-btn ui-danger"
                  :disabled="busy || checkedIds.length === 0 || store.proofreadMode"
                  @click="deleteTargets = [...checkedIds]"
                >
                  批量删除（{{ checkedIds.length }}）
                </button>
              </template>
            </div>
            <div
              v-if="deleteTargets.length"
              class="delete-confirm template-confirm"
            >
              <span>删除“{{ deleteNames }}”{{ deleteTargets.length > 3 ? '等' : '' }}共 {{ deleteTargets.length }} 个模板及全部版本、绑定和原件？不可恢复，有有效绑定的模板会保留并提示。</span>
              <button
                class="ui-btn"
                :disabled="busy"
                @click="deleteTargets = []"
              >
                取消
              </button>
              <button
                class="ui-btn ui-danger"
                :disabled="busy"
                @click="removeTemplates"
              >
                {{ busy ? '删除中…' : '确认删除模板' }}
              </button>
            </div>
            <p
              v-if="deleteResult"
              class="notice"
              role="status"
            >
              {{ deleteResult }}
            </p>
            <div
              v-for="t in templates"
              :key="t.id"
              class="template-row"
            >
              <input
                v-if="batchMode"
                type="checkbox"
                :aria-label="`选择模板：${t.filename}`"
                :checked="checkedIds.includes(t.id)"
                :disabled="busy"
                @change="check(t.id)"
              >
              <button
                class="template-item"
                :class="{ selected: selectedId === t.id }"
                :aria-pressed="selectedId === t.id"
                :disabled="busy"
                @click="selectedId = t.id"
              >
                <strong>{{ t.filename }}</strong>
                <span>{{ t.status === 'ready' ? '可使用' : '待校对' }} · {{ t.regions_count }} 个区域</span>
                <small>更新 {{ date(t.updated_at) }}</small>
              </button>
            </div>
            <p
              v-if="templates.length === 0"
              class="empty"
            >
              {{ query.trim() ? '没有匹配的模板' : '导入 DOCX 模板开始使用' }}
            </p>
          </div>
        </aside>
        <section
          class="version-panel"
          aria-label="内容版本列表"
        >
          <template v-if="selected">
            <div class="version-heading">
              <h3>{{ selected.filename }}</h3><p>模板决定版式，内容版本保存不同的块组合。</p>
              <button
                class="ui-btn ui-danger delete-template"
                :disabled="busy || store.proofreadMode"
                @click="deleteTargets = [selected.id]"
              >
                删除模板
              </button>
            </div>
            <div class="version-heading-actions">
              <strong>内容版本 <span class="muted">{{ versions.length }}</span></strong><button
                class="ui-btn"
                :disabled="busy || loading || store.proofreadMode"
                @click="edit('create')"
              >
                创建空白版本
              </button>
            </div>
            <p
              v-if="store.proofreadMode"
              class="notice"
            >
              当前为校对模式，退出校对后可管理和使用内容版本。
            </p>
            <p
              v-if="loading"
              class="empty"
            >
              正在加载版本…
            </p>
            <p
              v-if="error"
              class="error"
              role="alert"
            >
              {{ error }} <button
                class="ui-btn"
                :disabled="busy"
                @click="load"
              >
                重试
              </button>
            </p>
            <p
              v-if="notice"
              class="notice"
              role="status"
            >
              {{ notice }}
            </p>
            <div class="version-items">
              <article
                v-for="v in versions"
                :key="v.id"
                class="version-item"
                :class="{ current: store.currentVersionId === v.id }"
              >
                <div class="version-info">
                  <strong>{{ v.name }}</strong><span
                    v-if="store.currentVersionId === v.id"
                    class="current-badge"
                  >当前使用</span><p>{{ v.binding_count }} 项绑定 · 更新 {{ date(v.updated_at) }}</p>
                </div>
                <div class="version-ops">
                  <button
                    class="ui-btn ui-primary"
                    :disabled="busy || store.proofreadMode"
                    @click="emit('use', selected.id, v.id)"
                  >
                    使用
                  </button>
                  <button
                    class="ui-btn"
                    :disabled="busy || store.proofreadMode"
                    @click="edit('create', v, true)"
                  >
                    复制
                  </button>
                  <button
                    class="ui-btn"
                    :disabled="busy || store.proofreadMode"
                    @click="edit('rename', v)"
                  >
                    重命名
                  </button>
                  <details class="item-menu">
                    <summary aria-label="更多版本操作">
                      •••
                    </summary><button
                      class="ui-btn ui-danger"
                      :disabled="busy || store.proofreadMode || versions.length <= 1"
                      @click="deletingId = v.id"
                    >
                      删除版本
                    </button>
                  </details>
                </div>
                <div
                  v-if="deletingId === v.id"
                  class="delete-confirm"
                >
                  <span>删除“{{ v.name }}”及其绑定？此操作不可恢复。</span><button
                    class="ui-btn"
                    :disabled="busy"
                    @click="deletingId = null"
                  >
                    取消
                  </button><button
                    class="ui-btn ui-danger"
                    :disabled="busy"
                    @click="remove(v)"
                  >
                    确认删除
                  </button>
                </div>
              </article>
              <div
                v-if="!loading && !error && versions.length === 0"
                class="empty"
              >
                <p>此模板还没有内容版本</p><button
                  class="ui-btn"
                  :disabled="busy"
                  @click="emit('use', selected.id, null)"
                >
                  打开模板校对
                </button>
              </div>
            </div>
          </template>
          <p
            v-else
            class="empty"
          >
            先选择或导入一个模板
          </p>
        </section>
      </div>
      <VersionDialog
        v-if="editor"
        :mode="editor.mode"
        :initial-name="editor.mode === 'rename' ? editor.source?.name ?? '' : editor.copy ? `${editor.source?.name ?? ''} 副本`.slice(0, 30) : ''"
        :can-copy="editor.copy"
        :copy-mode="editor.copy ? 'copy' : 'blank'"
        :error="editorError"
        :submitting="busy"
        @submit="save"
        @close="!busy && (editor = null)"
      />
    </section>
  </dialog>
</template>

<style scoped>
.batch-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; }
.batch-bar label { display: flex; align-items: center; gap: 4px; }
.template-row { display: flex; align-items: flex-start; gap: 8px; }
.template-row .template-item { min-width: 0; }
.template-row > input { margin-top: 20px; flex-shrink: 0; }
.template-confirm { margin: 0 0 12px; }
.delete-template { margin-top: 12px; }
.dialog-mask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop); }
.manager-card { width: min(1040px, calc(100vw - 40px)); height: min(720px, calc(100dvh - 48px)); display: flex; flex-direction: column; background: var(--bg-surface); border-radius: 14px; box-shadow: 0 8px 36px var(--shadow-modal); overflow: hidden; }
.manager-head { display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid var(--border); }
h2, h3, p { margin: 0; } h2 { font-size: 20px; } h3 { font-size: 16px; overflow-wrap: anywhere; } .manager-head p, .version-heading p { font-size: 13px; color: var(--text-2); margin-top: 6px; }
.manager-body { display: grid; grid-template-columns: 330px minmax(0, 1fr); flex: 1; min-height: 0; }
.template-list { display: flex; flex-direction: column; min-height: 0; padding: 18px; border-right: 1px solid var(--border); background: var(--bg-muted); }
.search-label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; font-weight: 600; }
.search-label input { width: 100%; }
.list-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 14px 0; font-size: 12px; color: var(--text-2); }
.template-items { overflow: auto; min-height: 0; }
.template-item { width: 100%; display: flex; flex-direction: column; gap: 7px; padding: 14px; margin-bottom: 8px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; text-align: left; cursor: pointer; }
.template-item strong { font-size: 14px; overflow-wrap: anywhere; } .template-item span, .template-item small { font-size: 12px; color: var(--text-2); }
.template-item.selected { border-color: var(--primary); background: var(--primary-bg-subtle); }
.version-panel { padding: 22px; min-width: 0; overflow: auto; }
.version-heading { padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.version-heading-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 20px 0 14px; }
.version-item { padding: 16px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 10px; }
.version-item.current { border-color: var(--primary); } .version-info strong { overflow-wrap: anywhere; }
.version-info p { margin-top: 8px; font-size: 12px; color: var(--text-2); }
.current-badge { display: inline-block; margin-left: 8px; padding: 2px 6px; color: var(--primary); background: var(--primary-bg-subtle); font-size: 12px; border-radius: 4px; }
.version-ops { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.delete-confirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; font-size: 13px; color: var(--danger); }
.delete-confirm span { flex-basis: 100%; overflow-wrap: anywhere; } .muted { color: var(--text-3); }
.empty { padding: 24px 8px; color: var(--text-2); font-size: 13px; text-align: center; }
.error, .notice { margin: 12px 0; padding: 10px; font-size: 13px; border-radius: 6px; overflow-wrap: anywhere; }
.error { color: var(--danger); background: var(--danger-bg-subtle); } .notice { color: var(--text-2); background: var(--bg-muted); }
.icon-btn { border: none; background: none; font-size: 24px; cursor: pointer; color: var(--text-2); }
.item-menu { position: relative; } .item-menu summary { cursor: pointer; padding: 8px; list-style: none; }
.item-menu > button { position: absolute; right: 0; top: 100%; z-index: 2; white-space: nowrap; background: var(--bg-surface); box-shadow: 0 4px 12px var(--shadow-modal); }
@media (max-width: 760px) { .manager-card { width: calc(100vw - 24px); height: calc(100dvh - 24px); } .manager-head { padding: 16px; } .manager-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(220px, 42%) minmax(0, 1fr); } .template-list { padding: 12px; border-right: none; border-bottom: 1px solid var(--border); } .template-item { padding: 10px; } .version-panel { padding: 16px; } .list-heading { margin: 8px 0; } }
</style>
