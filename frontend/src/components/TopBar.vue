<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore } from '../stores/app'

const appStore = useAppStore()
onMounted(() => {
  void appStore.refreshHealth()
})
</script>

<template>
  <header class="top-bar">
    <!-- UI 调整①：顶部 tab 切换（工作台 / 模板制作指南） -->
    <nav class="tabs">
      <button
        class="tab"
        :class="{ active: appStore.activeTab === 'workbench' }"
        @click="appStore.setTab('workbench')"
      >
        工作台
      </button>
      <button
        class="tab"
        :class="{ active: appStore.activeTab === 'guide' }"
        @click="appStore.setTab('guide')"
      >
        模板制作指南
      </button>
    </nav>
    <div class="actions">
      <button disabled>
        导入模板
      </button>
      <button disabled>
        导出 DOCX
      </button>
      <span
        class="health-dot"
        :title="appStore.healthError ?? (appStore.health?.libreoffice.hint ?? '服务正常')"
        :class="appStore.health ? 'ok' : 'bad'"
      />
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #e2e3e5;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tab {
  padding: 5px 14px;
  font-size: 13px;
  color: #646a73;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.tab:hover {
  background: #f2f3f5;
  color: #1f2329;
}

.tab.active {
  color: #3370ff;
  background: rgba(51, 112, 255, 0.08);
  font-weight: 600;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.health-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-left: 8px;
}

.health-dot.ok {
  background: #34c724;
}

.health-dot.bad {
  background: #f54a45;
}
</style>
