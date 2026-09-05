<script setup lang="ts">
import BlockLibrary from './components/BlockLibrary.vue'
import StatusBar from './components/StatusBar.vue'
import TemplatePreview from './components/TemplatePreview.vue'
import TopBar from './components/TopBar.vue'
</script>

<template>
  <!-- PRD 4.0：顶部全局操作区 + 左块库 + 右预览 + 底部状态条 -->
  <div class="app-shell">
    <TopBar />
    <div class="main-columns">
      <BlockLibrary />
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
</style>
