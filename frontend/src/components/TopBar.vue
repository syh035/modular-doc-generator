<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore, type AppTab } from '../stores/app'
import { useHistoryStore } from '../stores/history'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore } from '../stores/preview'
import { useDocumentsStore } from '../stores/documents'

const appStore = useAppStore()
const previewStore = usePreviewStore()
const history = useHistoryStore()
const blocks = useBlocksStore()
const documents = useDocumentsStore()
const moreOpen = ref(false)
const moreRoot = ref<HTMLElement | null>(null)
const moreTrigger = ref<HTMLButtonElement | null>(null)
const moreMenu = ref<HTMLElement | null>(null)
function closeMore(returnFocus = false): void {
  const focusedInside = moreMenu.value?.contains(document.activeElement)
  moreOpen.value = false
  if (returnFocus && focusedInside) moreTrigger.value?.focus()
}
async function toggleMore(): Promise<void> {
  moreOpen.value = !moreOpen.value
  if (moreOpen.value) {
    await nextTick()
    moreMenu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }
}
function closeMoreOutside(event: MouseEvent): void {
  if (event.target instanceof Node && !moreRoot.value?.contains(event.target)) closeMore()
}
function moreKeydown(event: KeyboardEvent): void {
  if (!moreOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault(); closeMore(); moreTrigger.value?.focus()
  } else if (event.key === 'Tab') closeMore(true)
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const buttons = [...moreMenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
}
function selectTab(tab: AppTab): void {
  closeMore(true); appStore.setTab(tab)
}
function openArchives(archiveId: number | null = null): void {
  closeMore()
  appStore.openArchives(archiveId)
}
async function moveHistory(redo: boolean): Promise<void> {
  closeMore(true)
  await history.move(redo, async () => {
    await Promise.all([blocks.loadBlocks(), blocks.loadTags()])
    await previewStore.reloadAfterHistory()
    if (appStore.activeTab === 'documents') await documents.load()
  })
}
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = computed(() => previewStore.uploadPhase !== 'idle')
const now = ref(Date.now())
const renderStartedAt = ref<number | null>(null)
const rendering = computed(() => previewStore.refreshing || previewStore.status === 'loading')
let ticker: ReturnType<typeof setInterval> | null = null
const elapsed = computed(() => Math.floor((now.value - (previewStore.uploadStartedAt ?? renderStartedAt.value ?? now.value)) / 1000))
watch([() => previewStore.uploadStartedAt, rendering], ([started, active]) => {
  if (ticker) clearInterval(ticker)
  ticker = null
  now.value = Date.now()
  renderStartedAt.value = active ? Date.now() : null
  if (started !== null || active) ticker = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
  document.removeEventListener('click', closeMoreOutside)
  document.removeEventListener('keydown', moreKeydown)
})

onMounted(() => {
  void appStore.refreshHealth()
  document.addEventListener('click', closeMoreOutside)
  document.addEventListener('keydown', moreKeydown)
})

/** 打开系统文件选择框（仅 .docx）。 */
function pickFile(): void {
  closeMore(true)
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
  appStore.setTab('workbench')
  const result = await previewStore.uploadTemplate(file)
  if (!result.ok) {
    alert(result.error ?? '导入失败')
  }
}
defineExpose({ pickFile, openArchives })
</script>

<template>
  <header class="top-bar">
    <strong class="brand">模块化文档生成助手</strong>
    <nav
      class="tabs"
      aria-label="主导航"
    >
      <button
        class="tab"
        :class="{ active: ['documents', 'workbench'].includes(appStore.activeTab) }"
        :aria-current="['documents', 'workbench'].includes(appStore.activeTab) ? 'page' : undefined"
        @click="selectTab('documents')"
      >
        文稿
      </button>
      <button
        class="tab"
        :class="{ active: appStore.activeTab === 'templates' }"
        :aria-current="appStore.activeTab === 'templates' ? 'page' : undefined"
        @click="selectTab('templates')"
      >
        模板
      </button>
      <button
        class="tab"
        :class="{ active: appStore.activeTab === 'materials' }"
        :aria-current="appStore.activeTab === 'materials' ? 'page' : undefined"
        @click="selectTab('materials')"
      >
        素材
      </button>
      <button
        class="tab"
        :class="{ active: appStore.activeTab === 'archives' }"
        :aria-current="appStore.activeTab === 'archives' ? 'page' : undefined"
        :disabled="uploading || previewStore.refreshing"
        @click="openArchives()"
      >
        归档库
      </button>
    </nav>
    <div class="actions">
      <input
        ref="fileInput"
        type="file"
        accept=".docx"
        hidden
        @change="onFileChange"
      >
      <div
        ref="moreRoot"
        class="more"
      >
        <button
          ref="moreTrigger"
          class="more-trigger"
          aria-haspopup="menu"
          :aria-expanded="moreOpen"
          aria-controls="top-more-menu"
          @click="toggleMore"
        >
          更多 <span aria-hidden="true">⌄</span>
        </button>
        <div
          v-if="moreOpen"
          id="top-more-menu"
          ref="moreMenu"
          class="more-menu"
          role="menu"
          aria-label="更多操作"
        >
          <button
            role="menuitem"
            :disabled="uploading"
            data-testid="import-template"
            @click="pickFile"
          >
            {{ uploading ? '导入中…' : '导入模板' }}
          </button>
          <button
            role="menuitem"
            @click="selectTab('guide')"
          >
            模板制作指南
          </button>
          <template v-if="history.enabled">
            <div
              class="menu-divider"
              role="separator"
            />
            <button
              role="menuitem"
              :disabled="!history.canUndo || previewStore.refreshing || uploading || previewStore.exportBusy"
              :title="`撤销 ${history.undoLabel}（⌘Z）`"
              @click="moveHistory(false)"
            >
              撤销 <kbd>⌘Z</kbd>
            </button>
            <button
              role="menuitem"
              :disabled="!history.canRedo || previewStore.refreshing || uploading || previewStore.exportBusy"
              :title="`重做 ${history.redoLabel}（⌘⇧Z）`"
              @click="moveHistory(true)"
            >
              重做 <kbd>⌘⇧Z</kbd>
            </button>
          </template>
        </div>
      </div>
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
    <p
      v-else-if="rendering && elapsed >= 5"
      class="upload-progress"
      role="status"
    >
      正在更新预览，已等待 {{ elapsed }} 秒。较大文档或首次转换需要更久，请稍候。
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
  padding: 5px 12px;
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
@media (max-width: 400px) { .tab { padding: 5px 8px; } .tabs { gap: 0; } }

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.more { position: relative; }
.more-trigger { min-height: 32px; padding: 4px 10px; border: 0; border-radius: 7px; color: var(--text-2); background: transparent; font-size: 13px; }
.more-trigger:hover, .more-trigger[aria-expanded=true] { color: var(--text-1); background: var(--bg-hover); }
.more-menu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 100; width: 190px; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); box-shadow: 0 6px 24px var(--shadow-modal); }
.more-menu button { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; color: var(--text-1); background: transparent; font-size: 13px; text-align: left; }
.more-menu button:hover:not(:disabled) { background: var(--bg-hover); }
.more-menu kbd { font: inherit; font-size: 11px; color: var(--text-3); }
.menu-divider { margin: 5px 4px; border-top: 1px solid var(--border); }
</style>
