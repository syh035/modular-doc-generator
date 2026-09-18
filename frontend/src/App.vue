<script setup lang="ts">
import { useAppStore } from './stores/app'
import { useBlocksStore } from './stores/blocks'
import BlockLibrary from './components/BlockLibrary.vue'
import GuidePage from './components/GuidePage.vue'
import StatusBar from './components/StatusBar.vue'
import TemplatePreview from './components/TemplatePreview.vue'
import TopBar from './components/TopBar.vue'

const appStore = useAppStore()
const blocksStore = useBlocksStore()

/** UI 调整②：块库抽屉左缘开关。 */
function toggleLibrary(): void {
  blocksStore.libraryOpen = !blocksStore.libraryOpen
}
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
      <button
        class="library-toggle"
        :title="blocksStore.libraryOpen ? '收起块库' : '展开块库'"
        @click="toggleLibrary"
      >
        {{ blocksStore.libraryOpen ? '‹' : '›' }}
      </button>
      <BlockLibrary v-show="blocksStore.libraryOpen" />
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

.library-toggle {
  width: 16px;
  flex-shrink: 0;
  padding: 0;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border: none;
  border-right: 1px solid #e2e3e5;
  cursor: pointer;
}

.library-toggle:hover {
  color: #3370ff;
  background: #f2f3f5;
}
</style>
