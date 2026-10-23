<script setup lang="ts">
import { ref } from 'vue'
import { createArchive } from '../api/archives'
import { ApiRequestError } from '../api/client'
import { useModalEsc } from '../composables/useModalEsc'
import { usePreviewStore } from '../stores/preview'

const emit = defineEmits<{ close: []; saved: [archiveId: number] }>()
const preview = usePreviewStore()
const versionId = preview.currentVersionId
const versionName = preview.versions.find(v => v.id === versionId)?.name ?? '文档定稿'
const name = ref(versionName)
const busy = ref(false)
const error = ref('')
const warning = ref(false)
const confirmOverflow = ref(false)
function close(): void { if (!busy.value) emit('close') }
useModalEsc(close)

async function save(): Promise<void> {
  if (busy.value || versionId === null || !name.value.trim()) return
  busy.value = true; error.value = ''
  try {
    const archive = await createArchive(versionId, name.value.trim(), confirmOverflow.value)
    emit('saved', archive.id)
  } catch (err) {
    warning.value = err instanceof ApiRequestError && err.code === 'EXPORT_LARGE_OVERFLOW'
    error.value = err instanceof Error ? err.message : String(err)
  } finally { busy.value = false }
}
</script>

<template>
  <dialog
    ref="modal"
    class="archive-dialog"
    aria-label="归档当前稿件"
    @click.self="close"
  >
    <form
      class="archive-card"
      @submit.prevent="save"
    >
      <header>
        <h2>归档当前稿件</h2>
        <button
          type="button"
          :disabled="busy"
          aria-label="关闭归档"
          @click="close"
        >
          关闭
        </button>
      </header>
      <p>保存此刻的 Word 和 PDF 到归档库。当前稿件仍可继续编辑，归档内容保持不变。</p>
      <label>归档名称<input
        v-model="name"
        data-modal-autofocus
        required
        maxlength="30"
        :disabled="busy"
        aria-label="归档名称"
      ></label>
      <label
        v-if="warning"
        class="warning"
      ><input
        v-model="confirmOverflow"
        type="checkbox"
        :disabled="busy"
      >已了解当前稿件存在大超出，仍按当前排版归档</label>
      <p
        v-if="error"
        role="alert"
        class="error"
      >
        {{ error }}
      </p>
      <footer>
        <button
          type="button"
          :disabled="busy"
          @click="close"
        >
          取消
        </button>
        <button
          type="submit"
          class="primary"
          :disabled="busy || versionId === null || !name.trim() || (warning && !confirmOverflow)"
        >
          {{ busy ? '正在归档…' : '保存到归档库' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.archive-dialog { position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 20px; border: 0; background: transparent; }
.archive-dialog::backdrop { background: var(--modal-backdrop); }
.archive-card { width: min(480px, 100%); max-height: calc(100dvh - 40px); margin: max(0px, calc((100dvh - 360px) / 3)) auto 0; padding: 24px; overflow: auto; background: var(--bg-surface); color: var(--text-1); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { font-size: 18px; } p { margin: 16px 0; color: var(--text-2); line-height: 1.7; font-size: 13px; }
label { display: block; font-size: 13px; } input:not([type=checkbox]) { display: block; width: 100%; margin: 8px 0 16px; padding: 8px; border: 1px solid var(--border-control); border-radius: 6px; }
.warning { margin: 16px 0; line-height: 1.7; } .warning input { margin-right: 6px; } .error { color: var(--danger); }
footer { justify-content: flex-end; margin-top: 20px; } button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; }
.primary { background: var(--primary); color: var(--text-on-primary); border-color: var(--primary); }
</style>
