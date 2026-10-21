<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiRequestError } from '../api/client'
import { createVersion, deleteVersion, renameVersion, type VersionInfo } from '../api/versions'
import { useAppStore } from '../stores/app'
import { useDocumentsStore } from '../stores/documents'
import { usePreviewStore } from '../stores/preview'
import DeleteDocumentDialog from './DeleteDocumentDialog.vue'
import VersionDialog from './VersionDialog.vue'

const props = defineProps<{ document: VersionInfo; canDelete: boolean; disabled?: boolean; compact?: boolean }>()
const emit = defineEmits<{ open: [document: VersionInfo] }>()
const documents = useDocumentsStore()
const preview = usePreviewStore()
const app = useAppStore()
const menu = ref<HTMLDetailsElement | null>(null)
const editor = ref<'copy' | 'rename' | 'delete' | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let disposed = false
function closeMenu(returnFocus = false): void {
  if (!menu.value) return
  const focused = menu.value.contains(document.activeElement)
  menu.value.open = false
  if (returnFocus && focused) menu.value.querySelector('summary')?.focus()
}
function outside(event: Event): void {
  if (event.target instanceof Node && !menu.value?.contains(event.target)) closeMenu()
}
function edit(action: 'copy' | 'rename' | 'delete'): void {
  if (busy.value || props.disabled || (action === 'delete' && !props.canDelete)) return
  closeMenu(true)
  error.value = null
  editor.value = action
}
function message(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === 'VERSION_NAME_TAKEN') return '此模板下已有同名文稿，请换一个名称'
  if (err instanceof ApiRequestError && err.code === 'LAST_VERSION') return '此模板至少需要保留一份文稿'
  return err instanceof Error ? err.message : String(err)
}
async function save(name: string): Promise<void> {
  if (busy.value || !editor.value || editor.value === 'delete') return
  const source = props.document, action = editor.value
  const sourcePage = app.activeTab
  busy.value = true; error.value = null
  let result: VersionInfo | null = null
  try {
    result = action === 'copy' ? await createVersion(source.template_id, name, source.id) : await renameVersion(source.id, name)
    documents.acceptDocument(result)
    if (preview.currentTemplateId === result.template_id) {
      preview.versions = action === 'rename'
        ? preview.versions.map(document => document.id === result!.id ? result! : document)
        : [...preview.versions.filter(document => document.id !== result!.id), result]
    }
    if (!disposed) editor.value = null
  } catch (err) { if (!disposed) error.value = message(err) }
  finally { busy.value = false }
  if (result && action === 'copy' && !disposed && app.activeTab === sourcePage) {
    await nextTick()
    if (!disposed) emit('open', result)
  }
}
async function remove(): Promise<void> {
  if (busy.value || !props.canDelete) return
  const source = props.document
  busy.value = true; error.value = null
  try {
    await deleteVersion(source.id)
    documents.removeDocument(source.template_id, source.id)
    if (preview.currentTemplateId === source.template_id) preview.versions = preview.versions.filter(document => document.id !== source.id)
    editor.value = null
    if (preview.currentTemplateId === source.template_id && preview.currentVersionId === source.id) {
      if (app.activeTab === 'workbench') app.setTab('documents')
      await preview.selectTemplate(null)
    }
    await nextTick()
    if (app.activeTab === 'documents' && document.activeElement === document.body) {
      const next = documents.groups.find(group => group.template.id === source.template_id)?.documents[0]
      document.getElementById(next ? `edit-document-${next.id}` : `template-toggle-${source.template_id}`)?.focus({ preventScroll: true })
    }
  } catch (err) { if (!disposed) error.value = message(err) }
  finally { busy.value = false }
}
onMounted(() => { document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside) })
onBeforeUnmount(() => {
  disposed = true
  document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside)
})
</script>

<template>
  <div
    class="document-actions"
    :class="{ compact }"
  >
    <details
      ref="menu"
      @keydown.esc.stop.prevent="closeMenu(true)"
    >
      <summary
        :aria-label="`${document.name}的文稿操作`"
        :aria-disabled="disabled || busy"
        @click="(disabled || busy) && $event.preventDefault()"
      >
        {{ compact ? '•••' : '文稿操作' }} <span
          v-if="!compact"
          aria-hidden="true"
        >⌄</span>
      </summary>
      <div class="action-menu">
        <button
          :disabled="disabled || busy"
          @click="edit('copy')"
        >
          另存为文稿
        </button>
        <button
          :disabled="disabled || busy"
          @click="edit('rename')"
        >
          重命名文稿
        </button>
        <slot :close="closeMenu" />
        <button
          class="danger"
          :disabled="disabled || busy || !canDelete"
          :title="canDelete ? undefined : '该模板至少保留一份文稿'"
          @click="edit('delete')"
        >
          删除文稿
        </button>
      </div>
    </details>
    <VersionDialog
      v-if="editor === 'copy' || editor === 'rename'"
      subject="document"
      :mode="editor === 'copy' ? 'create' : 'rename'"
      :copy-mode="editor === 'copy' ? 'copy' : undefined"
      :initial-name="editor === 'copy' ? `${document.name} 副本`.slice(0, 30) : document.name"
      :can-copy="editor === 'copy'"
      :error="error"
      :submitting="busy"
      @submit="save"
      @close="!busy && (editor = null)"
    />
    <DeleteDocumentDialog
      v-if="editor === 'delete'"
      :name="document.name"
      :busy="busy"
      :error="error"
      @confirm="remove"
      @close="!busy && (editor = null)"
    />
  </div>
</template>

<style scoped>
.document-actions { position: relative; flex-shrink: 0; font-size: 12px; }
summary { cursor: pointer; list-style: none; padding: 8px 10px; border-radius: 6px; white-space: nowrap; color: var(--text-2); }
summary::-webkit-details-marker { display: none; }
.compact summary { padding: 8px 6px; }
summary[aria-disabled=true] { opacity: .5; cursor: not-allowed; }
summary:hover, details[open] summary { background: var(--bg-hover); }
.action-menu { position: absolute; right: 0; top: 100%; z-index: 150; width: min(240px, calc(100vw - 32px)); padding: 6px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-surface); box-shadow: 0 6px 24px var(--shadow-modal); }
.action-menu > button { width: 100%; display: block; padding: 9px 10px; border: 0; color: var(--text-1); text-align: left; border-radius: 5px; font-size: 13px; }
.action-menu > button:hover:not(:disabled) { background: var(--bg-hover); }
.action-menu > .danger { color: var(--danger); border-top: 1px solid var(--border-subtle); margin-top: 5px; }
@container (max-width: 600px) { .document-actions:not(.compact) .action-menu { left: 0; right: auto; } }
</style>
