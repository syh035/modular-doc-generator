<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { DocumentTrial } from '../api/migrations'
import { bboxToOverlayRect } from '../pdf/geometry'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'

const props = withDefaults(defineProps<{ trial: DocumentTrial; occupied: Record<number, string>; disabled: boolean; zoom?: string }>(), { zoom: 'fit' })
const emit = defineEmits<{ place: [id: number]; ready: [value: boolean]; failed: [message: string]; 'update:zoom': [value: string] }>()
const container = ref<HTMLElement | null>(null)
const pages = shallowRef<RenderedPage[]>([])
const ready = ref(false)
const error = ref('')
const width = ref(0)
const zoom = computed({ get: () => props.zoom, set: value => emit('update:zoom', value) })
let generation = 0
let opened: OpenedPdf | null = null
let observer: ResizeObserver | null = null
const unlocated = computed(() => props.trial.items.filter(r => r.review_status !== 'excluded' && !r.bbox))

function frames(page: RenderedPage) {
  return props.trial.items.filter(r => r.review_status !== 'excluded').flatMap(region =>
    (region.bbox?.fragments ?? (region.bbox ? [region.bbox] : []))
      .filter(box => box.page === page.index)
      .map((box, index) => ({ region, key: `${region.id}-${index}`, rect: bboxToOverlayRect(box, page.viewport) })),
  )
}
function reset(): void {
  pages.value.forEach(page => page.cancel())
  pages.value = []
  void opened?.destroy()
  opened = null
  ready.value = false
  emit('ready', false)
}
watch(() => [props.trial, width.value, zoom.value], async () => {
  const seq = ++generation
  reset(); error.value = ''
  try {
    const bytes = Uint8Array.from(atob(props.trial.pdf_base64), character => character.charCodeAt(0))
    const doc = await openDocument(bytes.buffer)
    if (seq !== generation) { await doc.destroy(); return }
    opened = doc
    const prepared: RenderedPage[] = []
    for (let i = 1; i <= doc.document.numPages; i++) {
      const page = await doc.document.getPage(i)
      if (seq !== generation) return
      const scale = zoom.value === 'fit'
        ? Math.min(1.25, Math.max(120, width.value - 24) / page.getViewport({ scale: 1 }).width)
        : Number(zoom.value)
      prepared.push(preparePage(page, scale))
    }
    pages.value = prepared
    await nextTick()
    const canvases = container.value?.querySelectorAll('canvas')
    for (const [index, page] of prepared.entries()) {
      if (seq !== generation) return
      const canvas = canvases?.[index]
      if (canvas) await page.render(canvas)
    }
    if (seq === generation) { ready.value = true; emit('ready', true) }
  } catch (err) {
    if (seq === generation) {
      error.value = err instanceof Error ? err.message : String(err)
      emit('failed', error.value)
    }
  }
}, { immediate: true, flush: 'post' })
onMounted(() => {
  const element = container.value
  if (!element) return
  width.value = element.clientWidth
  observer = new ResizeObserver(() => { width.value = element.clientWidth })
  observer.observe(element)
})
onBeforeUnmount(() => { generation++; observer?.disconnect(); reset() })
</script>

<template>
  <div
    ref="container"
    class="migration-preview"
    aria-label="新模板套用预览"
  >
    <div class="zoom-tools">
      <label>预览缩放 <select
        v-model="zoom"
        aria-label="套用预览缩放"
      >
        <option value="fit">适合宽度</option>
        <option value="1">100%</option>
        <option value="1.5">150%</option>
      </select></label>
    </div>
    <p
      v-if="!ready && !error"
      role="status"
    >
      正在显示套用效果…
    </p>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <div
      v-for="page in pages"
      :key="page.index"
      class="page"
      :style="{ width: `${page.width}px`, height: `${page.height}px` }"
    >
      <canvas :aria-label="`套用预览第 ${page.index + 1} 页`" />
      <template v-if="ready">
        <button
          v-for="frame in frames(page)"
          :key="frame.key"
          class="position"
          :class="{ occupied: occupied[frame.region.id] }"
          :style="{ left: `${frame.rect.left}px`, top: `${frame.rect.top}px`, width: `${frame.rect.width}px`, height: `${Math.max(14, frame.rect.height)}px` }"
          :aria-label="`${frame.region.label}${occupied[frame.region.id] ? `：已放置${occupied[frame.region.id]}` : '：放在这里'}`"
          :title="occupied[frame.region.id] ? `${frame.region.label}已有文字，请先重新安排` : `放在${frame.region.label}`"
          :disabled="disabled"
          :data-target-region="frame.region.id"
          @click="emit('place', frame.region.id)"
        />
      </template>
    </div>
    <div
      v-if="ready && unlocated.length"
      class="unlocated"
    >
      <p>以下位置暂未定位，可按名称放置，生成后请检查：</p>
      <button
        v-for="region in unlocated"
        :key="region.id"
        :disabled="disabled"
        @click="emit('place', region.id)"
      >
        {{ region.label }}{{ occupied[region.id] ? '（已有文字）' : '' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.migration-preview { min-width: 0; height: 100%; overflow: auto; padding: 12px; box-sizing: border-box; background: var(--bg-hover); }
.zoom-tools { position: sticky; top: -12px; left: 0; z-index: 3; padding: 6px 0; margin: -6px 0 8px; background: var(--bg-hover); font-size: 12px; color: var(--text-2); }
.zoom-tools select { margin-left: 6px; padding: 4px; color: var(--text-1); border: 1px solid var(--border); border-radius: 4px; background: var(--bg-surface); }
.page { position: relative; margin: 0 auto 12px; background: white; box-shadow: 0 2px 8px var(--shadow-modal); }
canvas { display: block; }
.position { position: absolute; box-sizing: border-box; border: 1px dashed var(--primary); background: var(--primary-bg-region); cursor: pointer; padding: 0; }
.position:hover, .position:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.position.occupied { border-style: solid; border-color: var(--success); background: transparent; }
.unlocated { font-size: 12px; line-height: 1.6; }
.unlocated button { margin: 3px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; }
</style>
