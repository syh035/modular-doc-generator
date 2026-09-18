<script setup lang="ts">
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'

const appStore = useAppStore()
const previewStore = usePreviewStore()
</script>

<template>
  <!-- 底部状态条：左下角服务状态（绿点+文字，2026-09-18 自 TopBar 右上角迁入）；
       校对模式开关（M5b，选中模板才可用）/ 溢出提示（M7 实现） -->
  <footer class="status-bar">
    <span
      class="health"
      :class="{ bad: !!appStore.healthError }"
      :title="appStore.healthError ?? (appStore.health?.libreoffice.hint ?? '服务正常')"
    >
      <i class="dot" />
      <span v-if="appStore.healthError">{{ appStore.healthError }}</span>
      <span v-else-if="appStore.health">服务正常</span>
      <span v-else>正在连接本地服务…</span>
    </span>
    <span
      v-if="appStore.health && !appStore.health.libreoffice.available"
      class="warn"
    >
      LibreOffice 未安装：{{ appStore.health.libreoffice.hint }}
    </span>
    <label
      v-if="previewStore.currentTemplateId !== null"
      class="proofread-switch"
      title="开启后预览模板本体并标注候选区域，可确认/排除/框选新建区域"
    >
      <input
        type="checkbox"
        data-testid="proofread-toggle"
        :checked="previewStore.proofreadMode"
        @change="previewStore.toggleProofreadMode(($event.target as HTMLInputElement).checked)"
      >
      校对模式
    </label>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 4px 16px;
  font-size: 12px;
  color: #646a73;
  background: #fff;
  border-top: 1px solid #e2e3e5;
}

.health {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.health .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34c724; /* 绿 = 服务正常 */
}

.health.bad .dot {
  background: #f54a45;
}

.warn {
  color: #ff8800;
}

.proofread-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  cursor: pointer;
  user-select: none;
}

.proofread-switch input {
  accent-color: #3370ff;
}
</style>
