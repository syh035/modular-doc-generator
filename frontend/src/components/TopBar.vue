<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'

const appStore = useAppStore()
const previewStore = usePreviewStore()
onMounted(() => {
  void appStore.refreshHealth()
  void previewStore.loadTemplates()
})

function onTemplateChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  void previewStore.selectTemplate(value === '' ? null : Number(value))
}
</script>

<template>
  <header class="top-bar">
    <div class="selectors">
      <select
        class="selector template-select"
        :value="previewStore.currentTemplateId ?? ''"
        :disabled="previewStore.templates.length === 0"
        :title="previewStore.templatesError ?? '选择要预览的模板'"
        @change="onTemplateChange"
      >
        <option
          value=""
          disabled
        >
          {{ previewStore.templatesError ?? (previewStore.templates.length === 0 ? '（暂无模板）' : '（选择模板）') }}
        </option>
        <option
          v-for="t in previewStore.templates"
          :key="t.id"
          :value="t.id"
        >
          {{ t.filename }}
        </option>
      </select>
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
  align-items: center;
  gap: 24px;
  color: #646a73;
}

.template-select {
  max-width: 280px;
  padding: 2px 4px;
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
