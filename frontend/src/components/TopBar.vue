<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import { useHistoryStore } from '../stores/history'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore } from '../stores/preview'

const appStore = useAppStore()
const previewStore = usePreviewStore()
const history = useHistoryStore()
const blocks = useBlocksStore()
async function moveHistory(redo: boolean): Promise<void> {
  await history.move(redo, async () => {
    await Promise.all([blocks.loadBlocks(), blocks.loadTags()])
    await previewStore.reloadAfterHistory()
  })
}
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = computed(() => previewStore.uploadPhase !== 'idle')
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
const elapsed = computed(() => Math.floor((now.value - (previewStore.uploadStartedAt ?? now.value)) / 1000))
watch(() => previewStore.uploadStartedAt, started => {
  if (ticker) clearInterval(ticker)
  ticker = null
  now.value = Date.now()
  if (started !== null) ticker = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => { if (ticker) clearInterval(ticker) })

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
  const result = await previewStore.uploadTemplate(file)
  if (!result.ok) {
    alert(result.error ?? '导入失败')
  }
}
defineExpose({ pickFile })
</script>

<template>
  <header class="top-bar">
    <strong class="brand">模块化文档生成助手</strong>
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
      <button
        v-if="history.enabled"
        :disabled="!history.canUndo || previewStore.refreshing || uploading || previewStore.exportBusy"
        :title="`撤销 ${history.undoLabel}（⌘Z）`"
        @click="moveHistory(false)"
      >
        撤销
      </button>
      <button
        v-if="history.enabled"
        :disabled="!history.canRedo || previewStore.refreshing || uploading || previewStore.exportBusy"
        :title="`重做 ${history.redoLabel}（⌘⇧Z）`"
        @click="moveHistory(true)"
      >
        重做
      </button>
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
    <p
      v-if="history.error"
      role="alert"
    >
      {{ history.error }} <button @click="history.clear()">
        清空撤销记录
      </button>
    </p>
    <p
      v-if="uploading"
      class="upload-progress"
      role="status"
      data-testid="upload-progress"
    >
      {{ previewStore.uploadPhase === 'request' ? '正在上传并解析模板…' : '解析完成，正在生成预览…' }}
      <span v-if="elapsed >= 5">已等待 {{ elapsed }} 秒；首次转换或较大模板可能需要更久。</span>
    </p>
  </header>
</template>

<style scoped>
.top-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
}
.upload-progress { flex-basis: 100%; padding-top: 8px; color: var(--text-2); font-size: 12px; }
.brand { font-size: 15px; margin-right: 24px; color: var(--text-1); }
.tabs { margin-right: auto; }
@media (max-width: 760px) { .brand { display: none; } .top-bar { padding: 8px 12px; } }

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tab {
  padding: 5px 14px;
  font-size: 13px;
  color: var(--text-2);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.tab:hover {
  background: var(--bg-hover);
  color: var(--text-1);
}

.tab.active {
  color: var(--primary);
  background: var(--primary-bg-subtle);
  font-weight: 600;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions > button { min-height: 32px; border-radius: 7px; font-size: 13px; }
</style>
