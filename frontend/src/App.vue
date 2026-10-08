<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { useAppStore } from './stores/app'
import {
  LIBRARY_MAX_WIDTH,
  LIBRARY_MIN_WIDTH,
  useBlocksStore,
} from './stores/blocks'
import BlockLibrary from './components/BlockLibrary.vue'
import GuidePage from './components/GuidePage.vue'
import StatusBar from './components/StatusBar.vue'
import TemplatePreview from './components/TemplatePreview.vue'
import TopBar from './components/TopBar.vue'

const appStore = useAppStore()
const blocksStore = useBlocksStore()

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
    <TopBar />
    <GuidePage v-if="appStore.activeTab === 'guide'" />
    <div
      v-else
      class="main-columns"
    >
      <BlockLibrary v-show="blocksStore.libraryOpen" />
      <!-- UI 质量调整②批：分割线拖拽热区（骑缝覆盖分割线，hover 高亮） -->
      <div
        v-show="blocksStore.libraryOpen"
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
      <TemplatePreview />
    </div>
    <StatusBar />
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
  background: #d6e2ff;
}

.drawer-resizer:focus-visible {
  outline: 2px solid #3370ff;
  outline-offset: -2px;
  background: #d6e2ff;
}
</style>
