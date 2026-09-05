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
    <div class="selectors">
      <span class="selector">模板：{{ '（暂无）' }}</span>
      <span class="selector">版本：{{ '（暂无）' }}</span>
    </div>
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

.selectors {
  display: flex;
  gap: 24px;
  color: #646a73;
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
