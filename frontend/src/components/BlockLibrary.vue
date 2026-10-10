<script setup lang="ts">
/**
 * 左栏：字符块库（M2 完整实现）。
 *
 * - 平铺列表（更新时间倒序）+ 统一搜索（名称／正文／标签）+ 新建/编辑/删除（二次确认，软删 D11）
 * - 抽屉本体：宽度拖拽可调 + 展开/收起（libraryOpen，头部折叠按钮）
 * - 正向绑定流：点选块高亮 → 右栏点目标区域即绑定（PRD 4.4）
 */

import { computed, onMounted, ref, watch } from 'vue'
import type { Block } from '../api/blocks'
import { useBlocksStore } from '../stores/blocks'
import { usePreviewStore } from '../stores/preview'
import { matchesBlock } from '../utils/blockSearch'
import BlockEditor from './BlockEditor.vue'
import SharedBlockDialog from './SharedBlockDialog.vue'

const emit = defineEmits<{ select: [] }>()
const store = useBlocksStore()
const query = ref('')
const sharedOpen = ref(false)
const sharing = ref(false)
const sharedError = ref<string | null>(null)
const previewStore = usePreviewStore()

// ---- 新建/编辑表单（一表两用）----
const showForm = ref(false)
const editingId = ref<number | null>(null)
const name = ref('')
const content = ref('')
const kind = ref<'text' | 'blank'>('text')
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
  kind.value = 'text'
  tagsInput.value = ''
  editingId.value = null
  showForm.value = false
}

function onNewClick(): void {
  if (deleting.value) return
  resetForm()
  formError.value = null
  showForm.value = true
}

function startEdit(block: Block): void {
  if (deleting.value) return
  editingId.value = block.id
  showForm.value = true
  name.value = block.name
  content.value = block.content
  kind.value = block.kind ?? 'text'
  tagsInput.value = block.tags.map(t => t.name).join('，')
  formError.value = null
}

function chooseBlock(id: number): void {
  if (deleting.value) return
  if (batchMode.value) {
    checkedIds.value = checkedIds.value.includes(id) ? checkedIds.value.filter(n => n !== id) : [...checkedIds.value, id]
    return
  }
  store.selectBlock(id)
  emit('select')
}

async function submit(): Promise<void> {
  formError.value = null
  const tagNames = parseTags(tagsInput.value)
  if (editingId.value !== null) {
    const ok = await store.updateExistingBlock(editingId.value, {
      name: name.value.trim(),
      content: kind.value === 'blank' ? '' : content.value,
      kind: kind.value,
      tags: tagNames, // 表单即整组替换语义
    })
    if (ok) {
      resetForm()
      void previewStore.refreshVersionRender()
    } else {
      formError.value = store.updateError
    }
    return
  }
  if (previewStore.currentTemplateId === null) return
  const ok = await store.createNewBlock(name.value.trim(), kind.value === 'blank' ? '' : content.value, tagNames, kind.value, previewStore.currentTemplateId)
  if (ok) {
    resetForm()
  } else {
    formError.value = store.createError
  }
}

// ---- 删除（二次确认，内联）----
const deletingId = ref<number | null>(null)
const deleting = ref(false)
const batchMode = ref(false)
const checkedIds = ref<number[]>([])
const batchConfirm = ref(false)
const batchResult = ref('')
async function confirmDelete(id: number): Promise<void> {
  if (deleting.value) return
  deleting.value = true
  const ok = await store.removeBlock(id)
  deleting.value = false
  deletingId.value = null
  if (ok) {
    checkedIds.value = checkedIds.value.filter(n => n !== id)
    batchConfirm.value = false
    // 被引用删除 → 绑定已置 missing：刷新版本预览让覆盖层回落黄框（D11）
    void previewStore.refreshVersionRender()
  }
}

// ---- 统一搜索：保留已有标签匹配，不叠加隐藏的历史标签筛选 ----
const visibleBlocks = computed(() => store.libraryBlocks.filter(b => matchesBlock(b, query.value)))
const allChecked = computed(() => visibleBlocks.value.length > 0 && visibleBlocks.value.every(b => checkedIds.value.includes(b.id)))
watch(query, () => { checkedIds.value = []; batchConfirm.value = false })
function toggleBatch(): void {
  batchMode.value = !batchMode.value
  checkedIds.value = []
  batchConfirm.value = false
  batchResult.value = ''
}
function selectAll(): void {
  checkedIds.value = allChecked.value ? [] : visibleBlocks.value.map(b => b.id)
  batchConfirm.value = false
}
async function removeChecked(): Promise<void> {
  if (deleting.value || checkedIds.value.length === 0) return
  deleting.value = true
  const targets = store.blocks.filter(b => checkedIds.value.includes(b.id))
  const failures: string[] = []
  const failedIds: number[] = []
  for (const block of targets) {
    if (!await store.removeBlock(block.id)) {
      failedIds.push(block.id)
      failures.push(`${block.name}：${store.mutationError ?? '删除失败'}`)
    }
  }
  checkedIds.value = failedIds
  batchConfirm.value = false
  batchResult.value = `已删除 ${targets.length - failedIds.length} 个字符块${failures.length ? `；未删除：${failures.join('；')}` : ''}`
  deleting.value = false
  if (targets.length > failedIds.length) void previewStore.refreshVersionRender()
}

watch(() => previewStore.currentTemplateId, () => {
  resetForm()
  sharedOpen.value = false; sharedError.value = null
  query.value = ''; store.activeTagId = null
  store.selectedBlockId = null
  checkedIds.value = []; batchMode.value = false; batchConfirm.value = false
  deletingId.value = null
})
watch([() => previewStore.currentTemplateId, () => previewStore.regions, () => previewStore.versions],
  () => { void store.loadTemplateBlocks(previewStore.currentTemplateId) }, { immediate: true })

async function share(id: number): Promise<void> {
  const templateId = previewStore.currentTemplateId
  if (templateId === null || sharing.value) return
  sharing.value = true
  const ok = await store.shareBlock(id, templateId)
  sharing.value = false
  if (previewStore.currentTemplateId !== templateId) return
  sharedError.value = ok ? null : store.mutationError
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
          :disabled="deleting || previewStore.currentTemplateId === null"
          @click="onNewClick"
        >
          + 新建字符块
        </button>
      </div>
    </div>

    <div
      v-if="previewStore.currentTemplateId === null"
      class="empty"
    >
      请先选择模板，再查看模板字符块库
    </div>
    <template v-else>
      <p class="scope-hint">
        当前模板的字符块
        <button
          class="ui-btn"
          :disabled="deleting"
          @click="sharedError = null; sharedOpen = true; store.loadBlocks()"
        >
          共享块
        </button>
      </p>
      <p
        v-if="store.selectedBlock && !store.libraryBlocks.some(b => b.id === store.selectedBlockId)"
        class="scope-hint"
        role="status"
      >
        已选「{{ store.selectedBlock.name }}」，可点击预览区域完成绑定
      </p>
      <label class="block-search"><span>搜索内容块</span><input
        v-model="query"
        type="search"
        :disabled="deleting"
        placeholder="名称、正文或标签"
      ></label>
      <div class="result-count">
        {{ visibleBlocks.length }} 个内容块
        <button
          class="ui-btn"
          :disabled="deleting"
          @click="toggleBatch"
        >
          {{ batchMode ? '退出批量' : '批量管理' }}
        </button>
      </div>
      <div
        v-if="batchMode"
        class="batch-bar"
      >
        <label><input
          type="checkbox"
          aria-label="全选当前字符块列表"
          :checked="allChecked"
          :indeterminate="checkedIds.length > 0 && !allChecked"
          :disabled="deleting || visibleBlocks.length === 0"
          @change="selectAll"
        >全选当前列表</label>
        <span>已选 {{ checkedIds.length }} 项</span>
        <button
          class="ui-btn ui-danger"
          :disabled="deleting || checkedIds.length === 0"
          @click="batchConfirm = true"
        >
          批量删除
        </button>
        <div
          v-if="batchConfirm"
          class="batch-confirm"
        >
          <span>删除所选 {{ checkedIds.length }} 个字符块？相关绑定将标记为缺失。</span>
          <button
            class="ui-btn"
            :disabled="deleting"
            @click="batchConfirm = false"
          >
            取消
          </button>
          <button
            class="ui-btn ui-danger"
            :disabled="deleting"
            @click="removeChecked"
          >
            {{ deleting ? '删除中…' : '确认批量删除' }}
          </button>
        </div>
      </div>
      <p
        v-if="batchResult"
        class="batch-result"
        role="status"
      >
        {{ batchResult }}
      </p>
      <BlockEditor
        v-if="showForm"
        v-model:name="name"
        v-model:content="content"
        v-model:kind="kind"
        v-model:tags="tagsInput"
        :editing="editingId !== null"
        :busy="store.creating || store.updating"
        :error="formError"
        :submit-label="submitLabel"
        @submit="submit"
        @close="resetForm"
      />

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
          v-if="store.libraryLoading"
          class="empty"
        >
          正在加载当前模板字符块…
        </div>
        <div
          v-else-if="store.libraryError"
          class="empty"
          role="alert"
        >
          {{ store.libraryError }}
        </div>
        <div
          v-else-if="store.libraryBlocks.length === 0"
          class="empty"
        >
          当前模板暂无字符块。可新建，或从“共享块”加入已有内容
        </div>
        <div
          v-else-if="visibleBlocks.length === 0"
          class="empty"
        >
          没有匹配的内容块，试试其他关键词
        </div>
        <div
          v-for="block in visibleBlocks"
          :key="block.id"
          class="block-item"
          :class="{ selected: store.selectedBlockId === block.id }"
          tabindex="0"
          @keydown.enter.self="chooseBlock(block.id)"
          @keydown.space.self.prevent="chooseBlock(block.id)"
          @click="chooseBlock(block.id)"
        >
          <div class="item-head">
            <input
              v-if="batchMode"
              type="checkbox"
              :aria-label="`选择字符块：${block.name}`"
              :checked="checkedIds.includes(block.id)"
              :disabled="deleting"
              @click.stop="chooseBlock(block.id)"
            >
            <span class="name">{{ block.name }}</span>
            <span
              class="ops"
              @click.stop
            >
              <template v-if="deletingId === block.id">
                <button
                  class="op danger"
                  :disabled="deleting"
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
                  class="op danger"
                  :disabled="deleting"
                  @click="deletingId = block.id"
                >删除</button>
                <details
                  class="block-menu"
                  name="block-actions"
                >
                  <summary :aria-label="`管理内容块：${block.name}`">•••</summary>
                  <div class="block-menu-actions">
                    <button
                      class="op"
                      @click="startEdit(block)"
                    >编辑</button>
                  </div>
                </details>
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
        </div>
      </div>
    </template>
    <SharedBlockDialog
      v-if="sharedOpen && previewStore.currentTemplateId !== null"
      :blocks="store.blocks"
      :member-ids="store.libraryBlocks.map(b => b.id)"
      :busy="sharing"
      :error="sharedError"
      @add="share"
      @close="sharedOpen = false"
    />
  </aside>
</template>

<style scoped>
.scope-hint { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; padding: 8px 12px; font-size: 12px; color: var(--text-3); border-bottom: 1px solid var(--border); }
.result-count { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.batch-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 12px; }
.batch-bar label { display: flex; align-items: center; gap: 4px; }
.batch-confirm { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 8px; color: var(--danger); }
.batch-confirm span { flex-basis: 100%; }
.batch-result { padding: 8px 12px; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.block-library {
  /* 宽度由 store.libraryWidth 驱动（拖拽可调，见 App.vue resizer） */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-right: 1px solid var(--border);
}

.header {
  height: 42px;
  box-sizing: border-box;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
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
  color: var(--text-2);
  background: none;
  border: 1px solid var(--border-control);
  border-radius: 4px;
  cursor: pointer;
}

.icon-collapse:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.primary {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--primary);
  background: none;
  border: 1px solid var(--primary);
  border-radius: 4px;
  cursor: pointer;
}

.primary:hover {
  background: var(--primary-bg-hover);
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.input {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--border-control);
  border-radius: 4px;
  resize: vertical;
  font-family: inherit;
}

.input:focus {
  outline: none;
  border-color: var(--primary);
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

.selected-tip {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--success);
  background: var(--success-bg-subtle);
  border-bottom: 1px solid var(--border);
}

.list-error {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--danger);
}

.block-list {
  flex: 1;
  overflow: auto;
  padding: 8px;
}

.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-3);
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
  color: var(--text-3);
}

/* 就地编辑表单：嵌在块卡片内底部，虚线分隔 */
.edit-form {
  width: 100%;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.block-item {
  display: block;
  width: 100%;
  margin-bottom: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-surface);
  text-align: left;
  cursor: pointer;
}

.block-item:hover {
  border-color: var(--primary);
}

.block-item.selected {
  border-color: var(--primary);
  background: var(--primary-bg-hover);
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
  color: var(--text-1);
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
  color: var(--text-2);
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
}

.op:hover {
  color: var(--primary);
  border-color: var(--primary);
}

.op.danger {
  color: var(--danger);
}

.op.danger:hover {
  border-color: var(--danger);
}

.content {
  /* UI 调整②批：最多显示前 2 行（约 44 字），超出省略；宽度压缩时以高度换宽度自然换行 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 12px;
  color: var(--text-3);
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
  color: var(--text-2);
  background: var(--bg-hover);
  border-radius: 8px;
}
.block-search { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px 6px; font-size: 12px; color: var(--text-2); }
.block-search input { width: 100%; }
.result-count { padding: 4px 14px 10px; font-size: 12px; color: var(--text-3); }
.block-menu { position: relative; }
.block-menu summary { cursor: pointer; list-style: none; padding: 0 6px; font-size: 16px; }
.block-menu-actions { position: absolute; right: 0; top: 100%; z-index: 8; display: flex; gap: 8px; padding: 10px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 16px var(--shadow-modal); }
.block-menu-actions .op { min-height: 30px; }
.block-item:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.block-library .content { -webkit-line-clamp: 2; }
</style>
