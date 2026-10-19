<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch, ApiRequestError } from '../api/client'
import { usePreviewStore } from '../stores/preview'
import { useModalEsc } from '../composables/useModalEsc'
import ArchivePreview from './ArchivePreview.vue'
import DataMaintenance from './DataMaintenance.vue'

interface Archive {
  id: number; name: string; version_name: string; template_name: string; created_at: string
}
const emit = defineEmits<{ close: [] }>()
const preview = usePreviewStore()
const archives = ref<Archive[]>([])
const name = ref(preview.versions.find(v => v.id === preview.currentVersionId)?.name ?? '文档定稿')
const busy = ref(false)
const error = ref('')
const message = ref('')
const warning = ref(false)
const confirmOverflow = ref(false)
const selected = ref<number | null>(null)
function close(): void { if (!busy.value) emit('close') }
useModalEsc(close)
async function load(): Promise<void> {
  archives.value = (await apiFetch<{ archives: Archive[] }>('/api/archives')).archives
}
onMounted(async () => { try { await load() } catch (err) { error.value = String(err) } })
async function freeze(): Promise<void> {
  const versionId = preview.currentVersionId
  if (versionId === null) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const archive = await apiFetch<Archive>(`/api/versions/${versionId}/archives`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.value.trim(), confirm_large_overflow: confirmOverflow.value }),
    })
    await load(); selected.value = archive.id; warning.value = false; confirmOverflow.value = false
    message.value = '已冻结归档。后续编辑不会改变这份稿件。'
  } catch (err) {
    warning.value = err instanceof ApiRequestError && err.code === 'EXPORT_LARGE_OVERFLOW'
    error.value = err instanceof Error ? err.message : String(err)
  } finally { busy.value = false }
}
async function remove(archive: Archive): Promise<void> {
  if (!confirm(`永久删除归档「${archive.name}」？此操作无法撤销，原内容版本不受影响。`)) return
  busy.value = true; error.value = ''
  try {
    await apiFetch(`/api/archives/${archive.id}`, { method: 'DELETE' })
    if (selected.value === archive.id) selected.value = null
    await load()
  } catch (err) { error.value = String(err) } finally { busy.value = false }
}
</script>

<template>
  <dialog
    ref="modal"
    class="library-dialog"
    aria-label="归档与备份"
    @click.self="close"
  >
    <section class="library-card">
      <header>
        <h2>归档与备份</h2><button
          :disabled="busy"
          aria-label="关闭归档与备份"
          @click="close"
        >
          关闭
        </button>
      </header>
      <p class="description">
        冻结归档会保存此刻的 Word 和 PDF，独立于模板、内容版本和共享块。归档可查看和下载。
      </p>
      <form
        class="freeze-form"
        @submit.prevent="freeze"
      >
        <label>归档名称<input
          v-model="name"
          data-modal-autofocus
          maxlength="30"
          :disabled="busy"
          aria-label="归档名称"
        ></label>
        <button
          type="submit"
          :disabled="busy || preview.currentVersionId === null || !name.trim()"
        >
          {{ busy ? '正在处理…' : '冻结当前版本' }}
        </button>
      </form>
      <p
        v-if="preview.currentVersionId === null"
        class="description"
      >
        先在工作台选择内容版本，再创建归档。
      </p>
      <label
        v-if="warning"
        class="warning"
      ><input
        v-model="confirmOverflow"
        type="checkbox"
      >已了解当前版本存在大超出，仍按当前排版冻结归档</label>
      <p
        v-if="error"
        role="alert"
        class="error"
      >
        {{ error }}
      </p>
      <p
        v-if="message"
        role="status"
      >
        {{ message }}
      </p>
      <div class="archive-layout">
        <div class="archive-list">
          <p v-if="!archives.length">
            暂无归档。保存第一份定稿后会显示在这里。
          </p>
          <article
            v-for="archive in archives"
            :key="archive.id"
            :class="{ selected: selected === archive.id }"
          >
            <strong>{{ archive.name }}</strong>
            <p>{{ archive.template_name }} · {{ archive.version_name }}</p>
            <p>{{ new Date(archive.created_at).toLocaleString() }}</p>
            <div class="row-actions">
              <button
                :disabled="busy"
                @click="selected = archive.id"
              >
                查看
              </button>
              <a
                :href="`/api/archives/${archive.id}/docx`"
                download
              >下载 Word</a>
              <a
                :href="`/api/archives/${archive.id}/pdf`"
                download
              >下载 PDF</a>
              <button
                :disabled="busy"
                @click="remove(archive)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
        <ArchivePreview
          v-if="selected !== null"
          :key="selected"
          :archive-id="selected"
        />
      </div>
      <DataMaintenance
        :locked="busy"
        @busy="busy = $event"
        @restored="selected = null; load()"
      />
    </section>
  </dialog>
</template>

<style scoped>
.library-dialog { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 20px; border: 0; background: transparent; }
.library-dialog::backdrop { background: var(--modal-backdrop); }
.library-card { width: min(1060px, 100%); max-height: calc(100dvh - 40px); margin: auto; padding: 24px; overflow: auto; background: var(--bg-surface); color: var(--text-1); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); }
header, .freeze-form, .row-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
header { justify-content: space-between; } h2, p { margin: 0 0 12px; }
.description, article p { color: var(--text-2); font-size: 13px; line-height: 1.6; }
.freeze-form { margin: 18px 0; } input { margin-left: 8px; padding: 7px; max-width: 100%; }
button, a { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; } a { color: var(--primary); text-decoration: none; }
.archive-layout { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 1.5fr); gap: 20px; margin-top: 16px; }
.archive-list { min-width: 0; } article { padding: 14px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; overflow-wrap: anywhere; }
article.selected { border-color: var(--primary); } article strong { display: block; margin-bottom: 8px; }
.row-actions { gap: 8px; font-size: 12px; } .error { color: var(--danger); } .warning { display: block; margin-bottom: 12px; }
@media (max-width: 760px) { .archive-layout { grid-template-columns: 1fr; } .library-card { padding: 16px; } }
</style>
