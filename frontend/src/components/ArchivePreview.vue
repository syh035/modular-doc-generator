<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchBlob } from '../api/client'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'

const props = defineProps<{ archiveId: number }>()
const container = ref<HTMLElement | null>(null)
const pages = ref<RenderedPage[]>([])
const error = ref('')
const loading = ref(true)
let document: OpenedPdf | null = null
let disposed = false
onMounted(async () => {
  try {
    const data = await (await fetchBlob(`/api/archives/${props.archiveId}/pdf`)).arrayBuffer()
    const opened = await openDocument(data)
    if (disposed) { await opened.destroy(); return }
    document = opened
    const width = Math.max(240, (container.value?.clientWidth ?? 600) - 24)
    const prepared: RenderedPage[] = []
    for (let i = 1; i <= opened.document.numPages; i++) {
      const page = await opened.document.getPage(i)
      if (disposed) return
      prepared.push(preparePage(page, Math.min(1.5, width / page.getViewport({ scale: 1 }).width)))
    }
    pages.value = prepared
    await nextTick()
    const canvases = container.value?.querySelectorAll('canvas') ?? []
    for (const [index, page] of prepared.entries()) {
      if (disposed) return
      const canvas = canvases[index]
      if (canvas) await page.render(canvas)
    }
  } catch (err) {
    if (!disposed) error.value = err instanceof Error ? err.message : String(err)
  } finally { loading.value = false }
})
onBeforeUnmount(() => {
  disposed = true
  pages.value.forEach(page => page.cancel())
  void document?.destroy()
})
</script>

<template>
  <div
    ref="container"
    class="archive-preview"
    aria-label="归档只读预览"
  >
    <p
      v-if="loading"
      role="status"
    >
      正在打开归档预览…
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <canvas
      v-for="page in pages"
      :key="page.index"
      :aria-label="`归档第 ${page.index + 1} 页`"
    />
  </div>
</template>

<style scoped>
.archive-preview { min-width: 0; overflow: auto; padding: 12px; background: var(--bg-hover); }
canvas { display: block; max-width: 100%; height: auto !important; margin: 0 auto 12px; }
</style>
