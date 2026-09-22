<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'

const appStore = useAppStore()
const previewStore = usePreviewStore()
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)

onMounted(() => {
  void appStore.refreshHealth()
})

/** 打开系统文件选择框（仅 .docx）。 */
function pickFile(): void {
  fileInput.value?.click()
}

/** 选中文件 → 上传解析 → 成功自动选中新模板；失败 alert 可读错误（同 M8 删除失败口径）。 */
async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = '' // 允许连续导入同一文件
  if (file === null) {
    return
  }
  uploading.value = true
  const result = await previewStore.uploadTemplate(file)
  uploading.value = false
  if (!result.ok) {
    alert(result.error ?? '导入失败')
  }
}
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
      <!-- 导入模板（占位按钮转正，M9 验收开放项）：导出功能在预览工具条，顶栏不再放导出占位 -->
      <input
        ref="fileInput"
        type="file"
        accept=".docx"
        hidden
        @change="onFileChange"
      >
      <button
        :disabled="uploading"
        @click="pickFile"
      >
        {{ uploading ? '导入中…' : '导入模板' }}
      </button>
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
</style>
