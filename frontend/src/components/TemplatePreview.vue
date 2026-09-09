<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Region } from '../api/templates'
import { bboxToOverlayRect, overlayKind } from '../pdf/geometry'
import { openDocument, preparePage, type OpenedPdf, type RenderedPage } from '../pdf/viewer'
import { usePreviewStore } from '../stores/preview'

const store = usePreviewStore()

/** 滚动容器（页面按 fit-width 平铺，纵向滚动）。 */
const scrollRef = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const pages = ref<RenderedPage[]>([])
/** 未定位区域（bbox=null，渲染未匹配）：无几何，只能列表提示（M5b 校对兜底）。 */
const unplaced = ref<Region[]>([])

let opened: OpenedPdf | null = null
let openedData: ArrayBuffer | null = null
let rebuildSeq = 0
let observer: ResizeObserver | null = null

function regionsOf(pageIndex: number): Region[] {
  return store.regions.filter(r => r.bbox !== null && r.bbox.page === pageIndex)
}

function overlayStyle(region: Region, page: RenderedPage) {
  const rect = bboxToOverlayRect(region.bbox!, page.viewport)
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  }
}

/** 重建渲染：pdfData 变化重开文档；容器宽度变化仅按新 scale 重排。 */
async function rebuild(): Promise<void> {
  const seq = ++rebuildSeq
  unplaced.value = store.regions.filter(r => r.bbox === null)
  const data = store.pdfData
  if (data === null) {
    await opened?.destroy()
    opened = null
    openedData = null
    pages.value = []
    return
  }
  if (opened === null || openedData !== data) {
    await opened?.destroy()
    opened = await openDocument(data)
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
  await nextTick()
  if (seq !== rebuildSeq) {
    return
  }
  const canvases = Array.from(scrollRef.value?.querySelectorAll('canvas') ?? [])
  await Promise.all(list.map((p, i) => p.render(canvases[i])))
}

watch(
  () => [store.pdfData, containerWidth.value, store.regions],
  () => {
    void rebuild()
  },
)

onMounted(() => {
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
  void opened?.destroy()
  opened = null
  openedData = null
})
</script>

<template>
  <!-- 右栏：模板预览（只读，M5a）——pdfjs 渲染管线 PDF + 区域覆盖层 -->
  <section class="template-preview">
    <!-- 顶部工具条：模板名 + 覆盖层图例 -->
    <div
      v-if="store.status === 'ready'"
      class="preview-toolbar"
    >
      <span class="filename">{{ store.currentTemplate?.filename ?? `模板 #${store.currentTemplateId}` }}</span>
      <span class="legend">
        <i class="dot pending" />待校对 {{ store.regions.length - unplaced.length }}
        <i class="dot unrecognized" />未定位 {{ unplaced.length }}
      </span>
    </div>

    <div
      ref="scrollRef"
      class="preview-scroll"
    >
      <div
        v-if="store.status === 'idle'"
        class="state empty"
      >
        请在顶部选择模板开始预览
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
          <!-- 覆盖层：绿=已绑定（M6a 接数据）/ 黄=待校对 / 虚线灰=未识别 -->
          <div
            v-for="region in regionsOf(page.index)"
            :key="region.id"
            class="overlay"
            :class="overlayKind(region)"
            :style="overlayStyle(region, page)"
            :title="region.label"
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
  background: #eceff1;
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-bottom: 1px solid #e2e3e5;
}

.filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.legend {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin: 0 4px 0 12px;
  border-radius: 2px;
}

.dot.pending {
  background: rgba(255, 196, 0, 0.35);
  border: 1px solid #ffb900;
}

.dot.unrecognized {
  background: transparent;
  border: 1px dashed #909399;
}

.preview-scroll {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px;
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
  pointer-events: none;
}

/* 黄=待校对（占位符已识别且几何定位成功） */
.overlay.pending {
  border: 1.5px solid #ffb900;
  background: rgba(255, 196, 0, 0.18);
}

/* 绿=已绑定：样式就绪，绑定数据 M6a 接入后由 overlayKind 返回 */
.overlay.bound {
  border: 1.5px solid #34c724;
  background: rgba(52, 199, 36, 0.15);
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
