<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Region } from '../api/templates'
import { bboxToOverlayRect, overlayKind } from '../pdf/geometry'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore, type DisplayRegion } from '../stores/preview'
import BindingDialog from './BindingDialog.vue'

const store = usePreviewStore()
const blocksStore = useBlocksStore()
/** 滚动容器（页面按 fit-width 平铺，纵向滚动）。 */
const scrollRef = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const pages = ref<RenderedPage[]>([])
/** 未定位区域（bbox=null，渲染未匹配）：无几何，只能列表提示（M5b 校对兜底）。 */
const unplaced = ref<Region[]>([])
/** 绑定浮层目标区域（null = 关闭）。 */
const dialogRegion = ref<DisplayRegion | null>(null)

let opened: OpenedPdf | null = null
let openedData: ArrayBuffer | null = null
let rebuildSeq = 0
let observer: ResizeObserver | null = null
/** 当前批次页面（含在飞渲染的取消句柄，P22）。 */
let activePages: RenderedPage[] = []

const boundCount = computed(
  () => store.regions.filter(r => overlayKind(r) === 'bound').length,
)

/** 模板下拉（UI 调整③：从顶栏挪到本工具条，idle 态也要可选）。 */
function onTemplateChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void store.selectTemplate(value === '' ? null : Number(value))
}

function regionsOf(pageIndex: number): DisplayRegion[] {
  return store.regions.filter(r => r.bbox !== null && r.bbox.page === pageIndex)
}

function overlayStyle(region: DisplayRegion, page: RenderedPage) {
  const rect = bboxToOverlayRect(region.bbox!, page.viewport)
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
}

function overlayTitle(region: DisplayRegion): string {
  if (region.binding?.status === 'active') {
    return `${region.label}（已绑定：${region.binding.block_name ?? `块 #${region.binding.block_id}`}）`
  }
  if (region.binding?.status === 'missing') {
    return `${region.label}（绑定块已删除，待重新绑定）`
  }
  return `${region.label}（未绑定，点击选择字符块）`
}

/** 区域点击（PRD 4.4）：左栏已选块 → 直接绑定/换绑；否则浮层选块/换绑/解绑。 */
function onRegionClick(region: DisplayRegion): void {
  const selectedId = blocksStore.selectedBlockId
  if (selectedId !== null) {
    void store.bindRegionToBlock(region.id, selectedId)
    return
  }
  dialogRegion.value = region
}

async function onDialogBind(blockId: number): Promise<void> {
  const region = dialogRegion.value
  dialogRegion.value = null
  if (region) {
    await store.bindRegionToBlock(region.id, blockId)
  }
}

async function onDialogUnbind(): Promise<void> {
  const region = dialogRegion.value
  dialogRegion.value = null
  if (region) {
    await store.unbindRegionFromBlock(region.id)
  }
}

/** 重建渲染：pdfData 变化重开文档；容器宽度变化仅按新 scale 重排。 */
function rebuild(): void {
  const seq = ++rebuildSeq
  doRebuild(seq).catch(err => {
    if (err instanceof Error && err.name === 'RenderingCancelledException') {
      return // 主动取消属正常流程（P22）
    }
    console.error('[TemplatePreview] 渲染失败：', err)
  })
}

async function doRebuild(seq: number): Promise<void> {
  unplaced.value = store.regions.filter(r => r.bbox === null)
  // P22：先取消上一批在飞渲染——seq 守卫拦不住已开始的 page.render，
  // 新旧批次并发打同一 canvas 会被 pdfjs 拒绝（白板根因）
  for (const p of activePages) {
    p.cancel()
  }
  activePages = []
  const data = store.pdfData
  if (data === null) {
    await opened?.destroy()
    opened = null
    openedData = null
    pages.value = []
    return
  }
  // loading 态 v-else 未渲染（DOM 无 canvas）→ 等 status 就绪后
  // watcher 再次触发 rebuild 补渲染（canvas 未就绪另有兜底检查）
  if (store.status !== 'ready') {
    return
  }
  if (opened === null || openedData !== data) {
    const previous = opened
    opened = null
    openedData = null
    const doc = await openDocument(data)
    if (seq !== rebuildSeq) {
      void doc.destroy()
      await previous?.destroy()
      return
    }
    await previous?.destroy()
    opened = doc
    openedData = data
  }
  if (seq !== rebuildSeq) {
    return
  }
  const width = containerWidth.value
  const first = await opened.document.getPage(1)
  const baseWidth = first.getViewport({ scale: 1 }).width
  const scale = Math.max((width - 32) / baseWidth, 0.1) // 左右各留 16px
  const list: RenderedPage[] = []
  for (let i = 1; i <= opened.document.numPages; i++) {
    const page = await opened.document.getPage(i)
    list.push(preparePage(page, scale))
  }
  if (seq !== rebuildSeq) {
    return
  }
  pages.value = list
  activePages = list
  await nextTick()
  if (seq !== rebuildSeq) {
    return
  }
  const canvases = Array.from(scrollRef.value?.querySelectorAll('canvas') ?? [])
  if (canvases.length !== list.length) {
    console.warn('[TemplatePreview] canvas 未就绪，跳过本轮渲染')
    return
  }
  await Promise.all(list.map((p, i) => p.render(canvases[i])))
}

watch(
  () => [store.pdfData, containerWidth.value, store.regions, store.status],
  () => {
    rebuild()
  },
)

onMounted(() => {
  void store.loadTemplates() // 模板列表数据源（UI 调整③：下拉随工具条常驻）
  containerWidth.value = scrollRef.value?.clientWidth ?? 0
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(entries => {
      containerWidth.value = entries[0]?.contentRect.width ?? 0
    })
    if (scrollRef.value) {
      observer.observe(scrollRef.value)
    }
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  rebuildSeq++
  for (const p of activePages) {
    p.cancel()
  }
  activePages = []
  void opened?.destroy()
  opened = null
  openedData = null
})
</script>

<template>
  <!-- 右栏：版本预览（模板+绑定替换成品）——pdfjs 渲染管线 PDF + 可交互覆盖层 -->
  <section class="template-preview">
    <!-- 顶部工具条：模板下拉（idle 态也可选）+ 刷新指示 + 覆盖层图例 -->
    <div class="preview-toolbar">
      <select
        class="template-select"
        :value="store.currentTemplateId ?? ''"
        :disabled="store.templates.length === 0"
        :title="store.templatesError ?? '选择要预览的模板'"
        @change="onTemplateChange"
      >
        <option
          value=""
          disabled
        >
          {{ store.templatesError ?? (store.templates.length === 0 ? '（暂无模板）' : '（选择模板）') }}
        </option>
        <option
          v-for="t in store.templates"
          :key="t.id"
          :value="t.id"
        >
          {{ t.filename }}
        </option>
      </select>
      <span class="legend">
        <span
          v-if="store.refreshing"
          class="refreshing"
        ><span class="spinner" />正在刷新预览…</span>
        <template v-if="store.status === 'ready'">
          <i class="dot bound" />已绑定 {{ boundCount }}
          <i class="dot pending" />待校对 {{ store.regions.length - unplaced.length - boundCount }}
          <i class="dot unrecognized" />未定位 {{ unplaced.length }}
        </template>
        <span
          v-else-if="store.status === 'idle'"
          class="toolbar-hint"
        >选择模板开始预览</span>
      </span>
    </div>

    <!-- 绑定/刷新错误横幅（不动摇 ready 态的已渲染内容） -->
    <div
      v-if="store.status === 'ready' && store.error"
      class="error-banner"
    >
      {{ store.error }}
    </div>

    <div
      ref="scrollRef"
      class="preview-scroll"
    >
      <div
        v-if="store.status === 'idle'"
        class="state empty"
      >
        请在上方工具条选择模板开始预览
      </div>
      <div
        v-else-if="store.status === 'loading'"
        class="state loading"
      >
        <span class="spinner" />
        正在生成预览…（首次渲染需调用 LibreOffice 转换，约需十几秒）
      </div>
      <div
        v-else-if="store.status === 'error'"
        class="state error"
      >
        {{ store.error }}
      </div>
      <template v-else>
        <div
          v-for="page in pages"
          :key="page.index"
          class="pdf-page"
          :style="{ width: `${page.width}px`, height: `${page.height}px` }"
        >
          <canvas class="pdf-canvas" />
          <!-- 覆盖层：绿=已绑定 / 黄=待校对（含 missing 回落）/ 虚线灰=未识别 -->
          <div
            v-for="region in regionsOf(page.index)"
            :key="region.id"
            class="overlay"
            :class="overlayKind(region)"
            :style="overlayStyle(region, page)"
            :title="overlayTitle(region)"
            role="button"
            tabindex="0"
            @click="onRegionClick(region)"
            @keydown.enter="onRegionClick(region)"
          />
        </div>
        <!-- 未定位区域（bbox=null）：无几何坐标，以虚线徽标提示，M5b 校对兜底 -->
        <div
          v-if="unplaced.length > 0"
          class="unplaced-bar"
        >
          <span class="unplaced-title">未定位区域（渲染未匹配，待校对）：</span>
          <span
            v-for="region in unplaced"
            :key="region.id"
            class="unplaced-chip"
            :title="region.placeholder ?? ''"
          >
            {{ region.label }}
          </span>
        </div>
        <!-- 绑定浮层（区域内遮罩定位，M6a） -->
        <BindingDialog
          v-if="dialogRegion"
          :region="dialogRegion"
          :blocks="blocksStore.blocks"
          @bind="onDialogBind"
          @unbind="onDialogUnbind"
          @close="dialogRegion = null"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.template-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  background: #eceff1;
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-bottom: 1px solid #e2e3e5;
}

.template-select {
  max-width: 280px;
  min-width: 140px;
  padding: 2px 4px;
  font-size: 12px;
  color: #1f2329;
}

.toolbar-hint {
  color: #8f959e;
}

.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.refreshing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
  color: #3370ff;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 12px;
  border-radius: 2px;
}

.dot.bound {
  background: rgba(52, 199, 36, 0.25);
  border: 1px solid #34c724;
}

.dot.pending {
  background: rgba(255, 196, 0, 0.35);
  border: 1px solid #ffb900;
}

.dot.unrecognized {
  background: transparent;
  border: 1px dashed #909399;
}

.error-banner {
  padding: 6px 16px;
  font-size: 12px;
  color: #f54a45;
  background: rgba(245, 74, 69, 0.06);
  border-bottom: 1px solid rgba(245, 74, 69, 0.2);
}

.preview-scroll {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
  position: relative;
}

.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8f959e;
}

.state.error {
  color: #f54a45;
}

.state.loading {
  gap: 8px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #d0d3d6;
  border-top-color: #3370ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.pdf-page {
  position: relative;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  flex-shrink: 0;
}

.pdf-canvas {
  display: block;
}

.overlay {
  position: absolute;
  cursor: pointer;
}

/* 绿=已绑定（active） */
.overlay.bound {
  border: 1.5px solid #34c724;
  background: rgba(52, 199, 36, 0.15);
}

/* 黄=待校对（未绑定或 missing 回落） */
.overlay.pending {
  border: 1.5px solid #ffb900;
  background: rgba(255, 196, 0, 0.18);
}

.overlay:hover {
  border-color: #3370ff;
}

.unplaced-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #e2e3e5;
  border-radius: 4px;
  font-size: 12px;
  color: #646a73;
}

.unplaced-title {
  flex-shrink: 0;
}

/* 虚线灰=未识别（bbox=null，无几何坐标） */
.unplaced-chip {
  border: 1px dashed #909399;
  border-radius: 3px;
  padding: 1px 6px;
  color: #909399;
}
</style>
