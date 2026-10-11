<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from './stores/app'
import { useHistoryStore } from './stores/history'
import { usePreviewStore } from './stores/preview'
import {
  LIBRARY_MAX_WIDTH,
  LIBRARY_MIN_WIDTH,
  useBlocksStore,
} from './stores/blocks'
import BlockLibrary from './components/BlockLibrary.vue'
import BlockDrawer from './components/BlockDrawer.vue'
import GuidePage from './components/GuidePage.vue'
import StatusBar from './components/StatusBar.vue'
import TemplatePreview from './components/TemplatePreview.vue'
import TopBar from './components/TopBar.vue'

const previewRef = ref<InstanceType<typeof TemplatePreview> | null>(null)
const topBarRef = ref<InstanceType<typeof TopBar> | null>(null)
const narrow = ref(false)
const narrowQuery = window.matchMedia('(max-width: 900px)')
function updateNarrow(): void { narrow.value = narrowQuery.matches }
onMounted(() => { updateNarrow(); narrowQuery.addEventListener('change', updateNarrow) })
onBeforeUnmount(() => narrowQuery.removeEventListener('change', updateNarrow))

const appStore = useAppStore()
const blocksStore = useBlocksStore()
const history = useHistoryStore()
const preview = usePreviewStore()
watch([() => preview.currentTemplateId, () => preview.regions, () => preview.versions],
  () => { void blocksStore.loadTemplateBlocks(preview.currentTemplateId) }, { immediate: true })
function onHistoryKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || event.altKey
      || target?.closest('input, textarea, select, [contenteditable=true]') || document.querySelector('dialog[open]')
      || preview.refreshing || preview.exportBusy || preview.uploadPhase !== 'idle') return
  if (event.shiftKey ? history.canRedo : history.canUndo) {
    event.preventDefault()
    void history.move(event.shiftKey, async () => {
      await Promise.all([blocksStore.loadBlocks(), blocksStore.loadTags()])
      await preview.reloadAfterHistory()
    })
  }
}
onMounted(() => { void history.initialize(); document.addEventListener('keydown', onHistoryKey) })
onBeforeUnmount(() => { history.dispose(); document.removeEventListener('keydown', onHistoryKey) })

/** UI 调整②批：分割线拖拽调宽——按下记录起点，拖动实时跟随，松开收敛落库。 */
let resizeStartX = 0
let resizeStartWidth = 0
let resizing = false
let previousCursor = ''
let previousUserSelect = ''

function startResize(e: MouseEvent): void {
  if (e.button !== 0) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).focus()
  resizing = true
  resizeStartX = e.clientX
  resizeStartWidth = blocksStore.libraryWidth
  previousCursor = document.body.style.cursor
  previousUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onResizing)
  document.addEventListener('mouseup', stopResize)
}

function onResizing(e: MouseEvent): void {
  // 边缘跟手：分割线跟随光标——向左拖变窄、向右拖变宽
  const next = resizeStartWidth + (e.clientX - resizeStartX)
  blocksStore.libraryWidth = Math.min(
    LIBRARY_MAX_WIDTH,
    Math.max(LIBRARY_MIN_WIDTH, Math.round(next)),
  )
}

function stopResize(): void {
  if (!resizing) return
  resizing = false
  blocksStore.setLibraryWidth(blocksStore.libraryWidth) // 收敛 + localStorage 记忆
  document.body.style.cursor = previousCursor
  document.body.style.userSelect = previousUserSelect
  document.removeEventListener('mousemove', onResizing)
  document.removeEventListener('mouseup', stopResize)
}

function onResizeKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  blocksStore.setLibraryWidth(blocksStore.libraryWidth + (e.key === 'ArrowRight' ? 16 : -16))
}

onBeforeUnmount(stopResize)
</script>

<template>
  <!-- PRD 4.0：顶部 tab + 左块库抽屉 + 右预览 + 底部状态条；指南页整页替换工作台 -->
  <div class="app-shell">
    <TopBar ref="topBarRef" />
    <GuidePage v-if="appStore.activeTab === 'guide'" />
    <div
      v-else
      class="main-columns"
    >
      <BlockLibrary
        v-if="!narrow"
        v-show="blocksStore.libraryOpen"
      />
      <BlockDrawer
        v-if="narrow && blocksStore.libraryOpen"
        @close="blocksStore.toggleLibrary()"
      />
      <!-- UI 质量调整②批：分割线拖拽热区（骑缝覆盖分割线，hover 高亮） -->
      <div
        v-show="!narrow && blocksStore.libraryOpen"
        class="drawer-resizer"
        role="separator"
        tabindex="0"
        aria-label="块库宽度"
        aria-orientation="vertical"
        :aria-valuemin="LIBRARY_MIN_WIDTH"
        :aria-valuemax="LIBRARY_MAX_WIDTH"
        :aria-valuenow="blocksStore.libraryWidth"
        title="拖动或使用左右方向键调整块库宽度"
        @mousedown="startResize"
        @keydown="onResizeKeydown"
      />
      <TemplatePreview
        ref="previewRef"
        @import="topBarRef?.pickFile()"
      />
    </div>
    <StatusBar @locate="previewRef?.jumpToRegion($event)" />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.main-columns {
  flex: 1;
  display: flex;
  min-height: 0;
}

.drawer-resizer {
  width: 12px;
  margin-left: -6px; /* 骑缝：覆盖抽屉右缘分割线，不改布局 */
  flex-shrink: 0;
  z-index: 5;
  cursor: col-resize;
  background: transparent;
}

.drawer-resizer:hover,
.drawer-resizer:active {
  background: var(--bg-resizer-active);
}

.drawer-resizer:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
  background: var(--bg-resizer-active);
}
</style>
