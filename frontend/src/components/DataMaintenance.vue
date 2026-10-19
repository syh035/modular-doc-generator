<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../api/client'
import { usePreviewStore } from '../stores/preview'
import { useBlocksStore } from '../stores/blocks'
import { clearHistoryBoundary } from '../api/historyHooks'

const emit = defineEmits<{ busy: [value: boolean]; restored: [] }>()
defineProps<{ locked?: boolean }>()
const busy = ref(false)
const error = ref('')
const message = ref('')
const file = ref<File | null>(null)
const inspection = ref<{ sha256: string; counts: Record<string, number> } | null>(null)
const confirmed = ref(false)
const backups = ref<{ name: string; bytes: number }[]>([])
const cache = ref<{ bytes: number; files: number } | null>(null)
function start(): void { busy.value = true; emit('busy', true); error.value = ''; message.value = '' }
function finish(): void { busy.value = false; emit('busy', false) }
async function refresh(): Promise<void> {
  backups.value = (await apiFetch<{ backups: typeof backups.value }>('/api/maintenance/backups')).backups
  cache.value = await apiFetch('/api/maintenance/cache')
}
onMounted(async () => { try { await refresh() } catch (err) { error.value = String(err) } })
async function backup(): Promise<void> {
  start()
  try {
    const response = await fetch('/api/maintenance/backup', { method: 'POST' })
    if (!response.ok) {
      const body = await response.json()
      throw new Error(body.error?.message ?? '备份失败')
    }
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `文档资料库-${new Date().toISOString().slice(0, 10)}.zip`
    document.body.append(anchor); anchor.click(); anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    message.value = '备份已生成，请在下载完成后妥善保存。包含模板、字符块、版本、标签和冻结归档。'
  } catch (err) { error.value = err instanceof Error ? err.message : String(err) } finally { finish() }
}
async function choose(event: Event): Promise<void> {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  inspection.value = null; confirmed.value = false
  if (!file.value) return
  start()
  try {
    const form = new FormData(); form.append('file', file.value)
    inspection.value = await apiFetch('/api/maintenance/restore/inspect', { method: 'POST', body: form })
  } catch (err) { error.value = String(err) } finally { finish() }
}
async function restore(): Promise<void> {
  if (!file.value || !inspection.value || !confirmed.value) return
  start()
  try {
    const form = new FormData(); form.append('file', file.value)
    form.append('expected_sha256', inspection.value.sha256); form.append('confirm', 'true')
    await apiFetch('/api/maintenance/restore', { method: 'POST', body: form })
    const preview = usePreviewStore()
    await preview.selectTemplate(null); await preview.loadTemplates()
    await useBlocksStore().loadTemplateBlocks(null); await clearHistoryBoundary()
    inspection.value = null; confirmed.value = false; file.value = null
    await refresh(); emit('restored')
    message.value = '资料库已恢复。恢复前的完整备份保留在下方，可下载后再次恢复。'
  } catch (err) { error.value = String(err) } finally { finish() }
}
async function clearCache(): Promise<void> {
  start()
  try {
    cache.value = await apiFetch('/api/maintenance/cache', { method: 'DELETE' })
    const preview = usePreviewStore()
    const hadPreview = preview.status === 'ready' && preview.currentTemplateId !== null
    await preview.refreshVersionRender()
    if (preview.error) throw new Error(`缓存已清理；重新预览失败：${preview.error}`)
    message.value = hadPreview ? '缓存已清理，当前预览已重新生成。模板和归档均保留。'
      : '缓存已清理。下次打开文档时会重新生成预览，模板和归档均保留。'
    await refresh()
  } catch (err) { error.value = String(err) } finally { finish() }
}
</script>

<template>
  <section
    class="maintenance"
    aria-label="资料库备份恢复"
  >
    <h3>备份与恢复</h3>
    <p>备份包含模板原件、内容库、版本和冻结归档。预览缓存与临时导出文件可重新生成，不计入备份。</p>
    <button
      :disabled="busy || locked"
      @click="backup"
    >
      导出完整备份
    </button>
    <label class="restore-file">选择备份文件<input
      type="file"
      accept=".zip"
      :disabled="busy || locked"
      aria-label="选择备份文件"
      @change="choose"
    ></label>
    <div
      v-if="inspection"
      class="restore-confirm"
    >
      <p>验证通过：{{ inspection.counts.templates }} 个模板、{{ inspection.counts.versions }} 个版本、{{ inspection.counts.blocks }} 个字符块、{{ inspection.counts.archives }} 份归档。</p>
      <label><input
        v-model="confirmed"
        type="checkbox"
        :disabled="busy || locked"
      >确认以此备份替换当前资料库；系统会先保留恢复前备份。</label>
      <button
        :disabled="busy || locked || !confirmed"
        @click="restore"
      >
        恢复备份
      </button>
    </div>
    <details v-if="backups.length">
      <summary>恢复前备份（{{ backups.length }} 份）</summary>
      <ul>
        <li
          v-for="item in backups"
          :key="item.name"
        >
          <a
            :href="`/api/maintenance/backups/${item.name}`"
            download
          >{{ item.name }}（{{ (item.bytes / 1024).toFixed(0) }} KB）</a>
        </li>
      </ul>
    </details>
    <h3>预览缓存</h3>
    <p v-if="cache">
      {{ cache.files }} 份缓存，占用 {{ (cache.bytes / 1024 / 1024).toFixed(1) }} MB。更换字体后也可手动重新生成预览。
    </p>
    <button
      :disabled="busy || locked"
      @click="clearCache"
    >
      清理缓存并重新预览
    </button>
    <p
      v-if="busy"
      role="status"
    >
      正在处理，请稍候…
    </p>
    <p
      v-if="message"
      role="status"
    >
      {{ message }}
    </p>
    <p
      v-if="error"
      role="alert"
      class="error"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.maintenance { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 12px; }
p { font-size: 13px; line-height: 1.7; color: var(--text-2); }
button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; }
.restore-file { display: flex; flex-wrap: wrap; gap: 12px; margin: 16px 0; font-size: 13px; }
.restore-confirm { padding: 12px; background: var(--bg-hover); border-radius: 8px; }
.restore-confirm label { display: block; margin-bottom: 12px; }
details { margin-top: 16px; overflow-wrap: anywhere; } .error { color: var(--danger); }
</style>
