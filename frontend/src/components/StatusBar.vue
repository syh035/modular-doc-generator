<script setup lang="ts">
import { useAppStore } from '../stores/app'

const appStore = useAppStore()
</script>

<template>
  <!-- 底部状态条：溢出提示 / 校对模式开关（M5/M7 实现，M0 显示服务状态） -->
  <footer class="status-bar">
    <span
      v-if="appStore.healthError"
      class="error"
    >{{ appStore.healthError }}</span>
    <template v-else-if="appStore.health">
      <span>服务正常</span>
      <span
        v-if="!appStore.health.libreoffice.available"
        class="warn"
      >
        LibreOffice 未安装：{{ appStore.health.libreoffice.hint }}
      </span>
    </template>
    <span v-else>正在连接本地服务…</span>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  gap: 16px;
  padding: 4px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-top: 1px solid #e2e3e5;
}

.error {
  color: #f54a45;
}

.warn {
  color: #ff8800;
}
</style>
