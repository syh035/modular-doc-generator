<script setup lang="ts">
/**
 * 左栏：字符块库（M2 完整实现）。
 *
 * - 平铺列表（更新时间倒序）+ 标签筛选（单行横滚，可整体收起）+ 新建/编辑/删除（二次确认，软删 D11）
 * - 标签管理：重命名（撞名即合并，全库生效）/ 删除
 * - 抽屉本体：宽度拖拽可调 + 展开/收起（libraryOpen，头部折叠按钮）
 * - 正向绑定流：点选块高亮 → 右栏点目标区域即绑定（PRD 4.4）
 */

import { computed, onMounted, reactive, ref } from 'vue'
import type { Block } from '../api/blocks'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore } from '../stores/preview'

const store = useBlocksStore()
const previewStore = usePreviewStore()

// ---- 新建/编辑表单（一表两用）----
const showForm = ref(false)
const editingId = ref<number | null>(null)
const name = ref('')
const content = ref('')
const tagsInput = ref('')
const formError = ref<string | null>(null)
const submitLabel = computed(() =>
  editingId.value !== null ? (store.updating ? '保存中…' : '保存') : store.creating ? '创建中…' : '创建',
)

/** 解析标签输入：逗号/顿号分隔，去空白去重保序。 */
function parseTags(raw: string): string[] {
  const names: string[] = []
  for (const part of raw.split(/[,，、]/)) {
    const t = part.trim()
    if (t && !names.includes(t)) {
      names.push(t)
    }
  }
  return names
}

function resetForm(): void {
  name.value = ''
  content.value = ''
  tagsInput.value = ''
  editingId.value = null
  showForm.value = false
}

function onNewClick(): void {
  if (editingId.value !== null) {
    resetForm()
    showForm.value = true
    return
  }
  showForm.value = !showForm.value
}

function startEdit(block: Block): void {
  editingId.value = block.id
  showForm.value = false // 就地编辑时收起顶部新建表单
  name.value = block.name
  content.value = block.content
  tagsInput.value = block.tags.map(t => t.name).join('，')
  formError.value = null
}

function cancelEdit(): void {
  resetForm()
}

async function submit(): Promise<void> {
  formError.value = null
  const tagNames = parseTags(tagsInput.value)
  if (editingId.value !== null) {
    const ok = await store.updateExistingBlock(editingId.value, {
      name: name.value.trim(),
      content: content.value,
      tags: tagNames, // 表单即整组替换语义
    })
    if (ok) {
      resetForm()
    } else {
      formError.value = store.updateError
    }
    return
  }
  const ok = await store.createNewBlock(name.value.trim(), content.value, tagNames)
  if (ok) {
    resetForm()
  } else {
    formError.value = store.createError
  }
}

// ---- 删除（二次确认，内联）----
const deletingId = ref<number | null>(null)

async function confirmDelete(id: number): Promise<void> {
  const ok = await store.removeBlock(id)
  deletingId.value = null
  if (ok) {
    // 被引用删除 → 绑定已置 missing：刷新版本预览让覆盖层回落黄框（D11）
    void previewStore.refreshVersionRender()
  }
}

// ---- 标签管理 ----
const manageOpen = ref(false)
const manageError = ref<string | null>(null)
const tagEdits = reactive<Record<number, string>>({})
/** 标签筛选栏整体收起/展开（收起后为：[标签管理][搜索框][展开按钮]）。 */
const tagsBarOpen = ref(true)

/** 标签搜索（折叠态）：关键字匹配标签名 → 过滤出挂有匹配标签的块。 */
const tagSearch = ref('')
const matchedTagIds = computed<Set<number> | null>(() => {
  const kw = tagSearch.value.trim()
  if (!kw) {
    return null
  }
  return new Set(store.tags.filter(t => t.name.includes(kw)).map(t => t.id))
})

/** 列表最终可见块 = 标签筛选 ∩ 标签搜索过滤。 */
const visibleBlocks = computed(() => {
  const ids = matchedTagIds.value
  return ids === null
    ? store.filteredBlocks
    : store.filteredBlocks.filter(b => b.tags.some(t => ids.has(t.id)))
})

function toggleManage(): void {
  manageOpen.value = !manageOpen.value
  manageError.value = null
  if (manageOpen.value) {
    for (const tag of store.tags) {
      tagEdits[tag.id] = tag.name
    }
  }
}

async function saveTag(id: number): Promise<void> {
  manageError.value = null
  const result = await store.renameExistingTag(id, tagEdits[id] ?? '')
  if (result === null) {
    tagEdits[id] = store.tags.find(t => t.id === id)?.name ?? '' // 刷新为落库名
  } else {
    manageError.value = result
  }
}

async function removeTagById(id: number): Promise<void> {
  manageError.value = null
  const ok = await store.removeTag(id)
  if (!ok) {
    manageError.value = store.mutationError
  }
}

onMounted(() => {
  void store.loadBlocks()
  void store.loadTags()
})
</script>

<template>
  <aside
    class="block-library"
    :style="{ width: store.libraryWidth + 'px' }"
  >
    <div class="header">
      <span>字符块库</span>
      <div class="header-ops">
        <button
          class="primary"
          @click="onNewClick"
        >
          {{ showForm ? '收起' : '+ 新建字符块' }}
        </button>
        <!-- UI 调整②批：矩形内置竖线折叠按钮（收起后在预览工具条左端展开） -->
        <button
          class="icon-collapse"
          title="收起块库"
          @click="store.toggleLibrary()"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <rect
              x="0.75"
              y="0.75"
              width="12.5"
              height="12.5"
              rx="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
            <line
              x1="4.5"
              y1="3.5"
              x2="4.5"
              y2="10.5"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <line
              x1="8"
              y1="3.5"
              x2="8"
              y2="10.5"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- 标签筛选（单行横向滚动，可整体收起）+ 行尾固定入口 -->
    <div class="tag-bar">
      <template v-if="tagsBarOpen">
        <div
          v-if="store.tags.length > 0"
          class="tag-scroll"
        >
          <button
            class="tag-chip"
            :class="{ active: store.activeTagId === null }"
            @click="store.toggleTagFilter(null)"
          >
            全部
          </button>
          <button
            v-for="tag in store.tags"
            :key="tag.id"
            class="tag-chip"
            :class="{ active: store.activeTagId === tag.id }"
            :title="`${tag.block_count} 个块`"
            @click="store.toggleTagFilter(tag.id)"
          >
            {{ tag.name }}（{{ tag.block_count }}）
          </button>
        </div>
        <span
          v-else
          class="tag-empty"
        >暂无标签</span>
      </template>
      <button
        class="manage-toggle"
        :class="{ open: manageOpen }"
        :title="manageOpen ? '收起标签管理' : '标签管理'"
        @click="toggleManage"
      >
        {{ manageOpen ? '收起管理' : '标签管理' }}
      </button>
      <!-- 折叠态：标签管理右侧放关键字搜索框（搜标签名，过滤块列表）；展开按钮固定最右 -->
      <input
        v-if="!tagsBarOpen"
        v-model="tagSearch"
        class="tag-search"
        placeholder="搜索标签…"
      >
      <button
        class="tagbar-toggle"
        :title="tagsBarOpen ? '收起标签栏' : '展开标签栏'"
        @click="tagsBarOpen = !tagsBarOpen"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          :style="{ transform: tagsBarOpen ? 'none' : 'rotate(-90deg)' }"
        >
          <path
            d="M2 3.5 L5 6.5 L8 3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!-- 标签管理：每行 = 标签名标题（含块数）在上 → 编辑框/操作在下（窄宽度不重叠） -->
    <div
      v-if="manageOpen"
      class="tag-manage"
    >
      <p class="manage-title">
        标签管理（重命名为已有标签名即合并，全库生效）
      </p>
      <div
        v-for="tag in store.tags"
        :key="tag.id"
        class="tag-row"
      >
        <div class="tag-row-head">
          <span class="tag-row-title">{{ tag.name }}</span>
          <span class="tag-row-count">{{ tag.block_count }} 个块</span>
        </div>
        <div class="tag-row-body">
          <input
            v-model="tagEdits[tag.id]"
            class="input"
            maxlength="20"
            aria-label="标签重命名"
            placeholder="重命名"
          >
          <button
            class="ghost"
            @click="saveTag(tag.id)"
          >
            保存
          </button>
          <button
            class="danger-btn"
            @click="removeTagById(tag.id)"
          >
            删除
          </button>
        </div>
      </div>
      <p
        v-if="store.tags.length === 0"
        class="hint"
      >
        暂无标签
      </p>
      <p
        v-if="manageError"
        class="form-error"
      >
        {{ manageError }}
      </p>
    </div>

    <!-- 新建表单（编辑走块卡片内就地表单）；每个字段带标题 -->
    <form
      v-if="showForm"
      class="create-form"
      @submit.prevent="submit"
    >
      <label class="field">
        <span class="field-label">名称</span>
        <input
          v-model="name"
          class="input"
          placeholder="2–30 字"
          maxlength="30"
        >
      </label>
      <label class="field">
        <span class="field-label">内容</span>
        <textarea
          v-model="content"
          class="input"
          rows="4"
          placeholder="≤5000 字，换行将渲染为换段"
        />
      </label>
      <label class="field">
        <span class="field-label">标签</span>
        <input
          v-model="tagsInput"
          class="input"
          placeholder="逗号分隔，最多 10 个"
        >
      </label>
      <p
        v-if="formError"
        class="form-error"
      >
        {{ formError }}
      </p>
      <div class="form-actions">
        <button
          type="submit"
          class="primary"
          :disabled="store.creating"
        >
          {{ submitLabel }}
        </button>
      </div>
    </form>

    <!-- 选中块提示（正向绑定流指引） -->
    <div
      v-if="store.selectedBlock"
      class="selected-tip"
    >
      已选中「{{ store.selectedBlock.name }}」，点击右侧预览区域绑定
    </div>

    <p
      v-if="store.error"
      class="list-error"
    >
      {{ store.error }}
    </p>
    <p
      v-if="store.mutationError"
      class="list-error"
    >
      {{ store.mutationError }}
    </p>

    <div class="block-list">
      <div
        v-if="store.blocks.length === 0 && !store.error"
        class="empty"
      >
        暂无字符块，点击上方按钮新建
      </div>
      <div
        v-else-if="visibleBlocks.length === 0"
        class="empty"
      >
        {{ tagSearch.trim() ? '无匹配标签的字符块' : '该标签下暂无字符块' }}
      </div>
      <div
        v-for="block in visibleBlocks"
        :key="block.id"
        class="block-item"
        :class="{ selected: store.selectedBlockId === block.id }"
        @click="store.selectBlock(block.id)"
      >
        <div class="item-head">
          <span class="name">{{ block.name }}</span>
          <span
            class="ops"
            @click.stop
          >
            <template v-if="deletingId === block.id">
              <button
                class="op danger"
                @click="confirmDelete(block.id)"
              >
                确认删除
              </button>
              <button
                class="op"
                @click="deletingId = null"
              >
                取消
              </button>
            </template>
            <template v-else>
              <button
                class="op"
                @click="startEdit(block)"
              >
                编辑
              </button>
              <button
                class="op danger"
                @click="deletingId = block.id"
              >
                删除
              </button>
            </template>
          </span>
        </div>
        <span class="content">{{ block.content }}</span>
        <span
          v-if="block.tags.length > 0"
          class="item-tags"
        >
          <span
            v-for="t in block.tags"
            :key="t.id"
            class="mini-tag"
          >
            {{ t.name }}
          </span>
        </span>
        <!-- 就地编辑：编辑框在块卡片下方，字段带标题 -->
        <form
          v-if="editingId === block.id"
          class="edit-form"
          @click.stop
          @submit.prevent="submit"
        >
          <label class="field">
            <span class="field-label">名称</span>
            <input
              v-model="name"
              class="input"
              placeholder="2–30 字"
              maxlength="30"
            >
          </label>
          <label class="field">
            <span class="field-label">内容</span>
            <textarea
              v-model="content"
              class="input"
              rows="4"
              placeholder="≤5000 字，换行将渲染为换段"
            />
          </label>
          <label class="field">
            <span class="field-label">标签</span>
            <input
              v-model="tagsInput"
              class="input"
              placeholder="逗号分隔，最多 10 个"
            >
          </label>
          <p
            v-if="formError"
            class="form-error"
          >
            {{ formError }}
          </p>
          <div class="form-actions">
            <button
              type="submit"
              class="primary"
              :disabled="store.updating"
            >
              {{ submitLabel }}
            </button>
            <button
              type="button"
              class="ghost"
              @click="cancelEdit"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.block-library {
  /* 宽度由 store.libraryWidth 驱动（拖拽可调，见 App.vue resizer） */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid #e2e3e5;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
  font-weight: 600;
  white-space: nowrap; /* 宽度下限=头部行不换行（LIBRARY_MIN_WIDTH），不允许多行 */
}

.header-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: #646a73;
  background: none;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  cursor: pointer;
}

.icon-collapse:hover {
  color: #3370ff;
  border-color: #3370ff;
}

.primary {
  padding: 4px 10px;
  font-size: 12px;
  color: #3370ff;
  background: none;
  border: 1px solid #3370ff;
  border-radius: 4px;
  cursor: pointer;
}

.primary:hover {
  background: rgba(51, 112, 255, 0.06);
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.ghost {
  padding: 4px 10px;
  font-size: 12px;
  color: #646a73;
  background: none;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  cursor: pointer;
}

.ghost:hover {
  color: #3370ff;
  border-color: #3370ff;
}

.danger-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: #f54a45;
  background: none;
  border: 1px solid rgba(245, 74, 69, 0.4);
  border-radius: 4px;
  cursor: pointer;
}

.danger-btn:hover {
  background: rgba(245, 74, 69, 0.06);
}

.tag-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
}

/* 单行横向滚动：标签多时不换行挤压行尾固定入口 */
.tag-scroll {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.tag-scroll::-webkit-scrollbar {
  height: 6px;
}

.tag-scroll::-webkit-scrollbar-thumb {
  background: #d0d3d6;
  border-radius: 3px;
}

.tag-empty {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: #a8abb0;
}

/* 行尾固定入口：不参与滚动、不收缩，保证完整呈现 */
.manage-toggle {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 12px;
  color: #646a73;
  background: none;
  border: 1px dashed #d0d3d6;
  border-radius: 10px;
  cursor: pointer;
}

.manage-toggle:hover,
.manage-toggle.open {
  color: #3370ff;
  border-color: #3370ff;
}

.tagbar-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: #646a73;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

/* 折叠态搜索框：占据标签管理与固定展开按钮之间的全部剩余空间 */
.tag-search {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  border: 1px solid #d0d3d6;
  border-radius: 12px;
}

.tag-search:focus {
  border-color: #3370ff;
  outline: none;
}

.tagbar-toggle:hover {
  color: #3370ff;
  background: #f2f3f5;
}

.tagbar-toggle svg {
  transition: transform 0.15s ease;
}

.tag-chip {
  flex: 0 0 auto; /* 单行横滚：chip 不收缩，溢出靠滚动条 */
  white-space: nowrap;
  padding: 2px 8px;
  font-size: 12px;
  color: #646a73;
  background: #f2f3f5;
  border: 1px solid transparent;
  border-radius: 10px;
  cursor: pointer;
}

.tag-chip:hover {
  color: #3370ff;
}

.tag-chip.active {
  color: #3370ff;
  background: rgba(51, 112, 255, 0.1);
  border-color: #3370ff;
}

.tag-manage {
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
  background: #fafbfc;
}

.manage-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: #8f959e;
}

.tag-row {
  margin-bottom: 8px;
}

/* 行头：标签名标题 + 块数（编辑框的标题，位于编辑框上方） */
.tag-row-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 2px;
}

.tag-row-title {
  font-size: 12px;
  font-weight: 600;
  color: #40464e;
}

.tag-row-count {
  font-size: 11px;
  color: #a8abb0;
}

/* 行体：编辑框压缩占余宽（min-width:0 防溢出重叠），按钮不收缩 */
.tag-row-body {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tag-row-body .input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  font-size: 12px;
  padding: 0 6px;
}

.tag-row-body button {
  flex: 0 0 auto;
  font-size: 12px;
  padding: 2px 8px;
}

.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8f959e;
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid #e2e3e5;
  background: #fafbfc;
}

.input {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  resize: vertical;
  font-family: inherit;
}

.input:focus {
  outline: none;
  border-color: #3370ff;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-error {
  margin: 0;
  font-size: 12px;
  color: #f54a45;
}

.selected-tip {
  padding: 6px 12px;
  font-size: 12px;
  color: #34c724;
  background: rgba(52, 199, 36, 0.08);
  border-bottom: 1px solid #e2e3e5;
}

.list-error {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: #f54a45;
}

.block-list {
  flex: 1;
  overflow: auto;
  padding: 8px;
}

.empty {
  padding: 24px;
  text-align: center;
  color: #8f959e;
  font-size: 13px;
}

/* 表单字段：标题在上、输入框在下（新建与就地编辑共用） */
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}

.field-label {
  font-size: 12px;
  color: #8f959e;
}

/* 就地编辑表单：嵌在块卡片内底部，虚线分隔 */
.edit-form {
  width: 100%;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #e2e3e5;
}

.block-item {
  display: block;
  width: 100%;
  margin-bottom: 6px;
  padding: 8px 10px;
  border: 1px solid #e2e3e5;
  border-radius: 6px;
  background: #fff;
  text-align: left;
  cursor: pointer;
}

.block-item:hover {
  border-color: #3370ff;
}

.block-item.selected {
  border-color: #3370ff;
  background: rgba(51, 112, 255, 0.06);
}

.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.name {
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.op {
  padding: 1px 6px;
  font-size: 11px;
  color: #646a73;
  background: none;
  border: 1px solid #e2e3e5;
  border-radius: 3px;
  cursor: pointer;
}

.op:hover {
  color: #3370ff;
  border-color: #3370ff;
}

.op.danger {
  color: #f54a45;
}

.op.danger:hover {
  border-color: #f54a45;
}

.content {
  /* UI 调整②批：最多显示前 2 行（约 44 字），超出省略；宽度压缩时以高度换宽度自然换行 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 12px;
  color: #8f959e;
  word-break: break-word;
  white-space: pre-wrap;
}

.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.mini-tag {
  padding: 0 6px;
  font-size: 11px;
  color: #646a73;
  background: #f2f3f5;
  border-radius: 8px;
}
</style>
