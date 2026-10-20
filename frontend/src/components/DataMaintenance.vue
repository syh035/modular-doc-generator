<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../api/client'
import { usePreviewStore } from '../stores/preview'
import { useModalEsc } from '../composables/useModalEsc'

const emit = defineEmits<{ close: [] }>()
const busy = ref(false)
const error = ref('')
const message = ref('')
const cache = ref<{ bytes: number; files: number } | null>(null)
function close(): void { if (!busy.value) emit('close') }
useModalEsc(close)
async function refresh(): Promise<void> {
  cache.value = await apiFetch('/api/maintenance/cache')
}
onMounted(async () => { try { await refresh() } catch (err) { error.value = String(err) } })
async function clearCache(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    cache.value = await apiFetch('/api/maintenance/cache', { method: 'DELETE' })
    const preview = usePreviewStore()
    const hadPreview = preview.status === 'ready' && preview.currentTemplateId !== null
    if (hadPreview) {
      await preview.refreshVersionRender()
      if (preview.error) throw new Error(`缓存已清理；重新预览失败：${preview.error}`)
    }
    message.value = hadPreview ? '缓存已清理，当前预览已重新生成。模板和归档均保留。'
      : '缓存已清理。下次打开文档时会重新生成预览，模板和归档均保留。'
    await refresh()
  } catch (err) { error.value = String(err) } finally { busy.value = false }
}
</script>

<template>
  <dialog
    ref="modal"
    class="maintenance"
    aria-label="预览维护"
    aria-modal="true"
    tabindex="-1"
    @click.self="close"
  >
    <section class="maintenance-card">
      <header>
        <h2>预览维护</h2>
        <button
          type="button"
          :disabled="busy"
          aria-label="关闭预览维护"
          @click="close"
        >
          关闭
        </button>
      </header>
      <p>预览异常或更换字体后，可清理缓存并重新生成。此操作保留模板、素材、稿件和归档。</p>
      <p v-if="cache">
        {{ cache.files }} 份缓存，占用 {{ (cache.bytes / 1024 / 1024).toFixed(1) }} MB。更换字体后也可手动重新生成预览。
      </p>
      <button
        :disabled="busy"
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
  </dialog>
</template>

<style scoped>
.maintenance { position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: 20px; border: 0; background: transparent; }
.maintenance::backdrop { background: var(--modal-backdrop); }
.maintenance-card { width: min(480px, 100%); max-height: calc(100dvh - 40px); margin: max(0px, calc((100dvh - 360px) / 3)) auto 0; padding: 24px; overflow: auto; background: var(--bg-surface); color: var(--text-1); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { font-size: 18px; }
p { font-size: 13px; line-height: 1.7; color: var(--text-2); }
button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 6px; }
.error { color: var(--danger); }
</style>
