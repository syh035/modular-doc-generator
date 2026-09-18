<script setup lang="ts">
/**
 * 左栏：字符块库（M2 完整实现）。
 *
 * - 分组列表（按分类聚拢）+ 标签筛选 + 新建/编辑/删除（二次确认，软删 D11）
 * - 标签管理：重命名（撞名即合并，全库生效）/ 删除
 * - 抽屉本体：展开/收起由 App.vue 左缘按钮控制（libraryOpen）
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
const category = ref('')
const tagsInput = ref('')
const formError = ref<string | null>(null)
const formVisible = computed(() => showForm.value || editingId.value !== null)
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
  category.value = ''
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
  showForm.value = false
  name.value = block.name
  content.value = block.content
  category.value = block.category
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
      category: category.value,
      tags: tagNames, // 表单即整组替换语义
    })
    if (ok) {
      resetForm()
    } else {
      formError.value = store.updateError
    }
    return
  }
  const ok = await store.createNewBlock(
    name.value.trim(),
    content.value,
    category.value,
    tagNames,
  )
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
  <aside class="block-library">
    <div class="header">
      <span>字符块库</span>
      <div class="header-ops">
        <button
          class="ghost"
          @click="toggleManage"
        >
          {{ manageOpen ? '收起管理' : '标签管理' }}
        </button>
        <button
          class="primary"
          @click="onNewClick"
        >
          {{ formVisible && editingId === null ? '收起' : '+ 新建字符块' }}
        </button>
      </div>
    </div>

    <!-- 标签筛选（单选开关） -->
    <div
      v-if="store.tags.length > 0"
      class="tag-bar"
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
        {{ tag.name }} {{ tag.block_count }}
      </button>
    </div>

    <!-- 标签管理：重命名（撞名即合并）/ 删除 -->
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
        <input
          v-model="tagEdits[tag.id]"
          class="input"
          maxlength="20"
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

    <!-- 新建/编辑表单 -->
    <form
      v-if="formVisible"
      class="create-form"
      @submit.prevent="submit"
    >
      <input
        v-model="name"
        class="input"
        placeholder="块名称（2–30 字）"
        maxlength="30"
      >
      <textarea
        v-model="content"
        class="input"
        rows="4"
        placeholder="块内容（≤5000 字，换行将渲染为换段）"
      />
      <input
        v-model="category"
        class="input"
        list="category-options"
        placeholder="分类（默认未分类）"
        maxlength="20"
      >
      <datalist id="category-options">
        <option
          v-for="c in store.categories"
          :key="c"
          :value="c"
        />
      </datalist>
      <input
        v-model="tagsInput"
        class="input"
        placeholder="标签（逗号分隔，最多 10 个）"
      >
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
          :disabled="store.creating || store.updating"
        >
          {{ submitLabel }}
        </button>
        <button
          v-if="editingId !== null"
          type="button"
          class="ghost"
          @click="cancelEdit"
        >
          取消
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
        v-else-if="store.blocks.length > 0 && store.groupedBlocks.length === 0"
        class="empty"
      >
        该标签下暂无字符块
      </div>
      <template
        v-for="group in store.groupedBlocks"
        :key="group.category"
      >
        <div class="group-header">
          {{ group.category }}（{{ group.blocks.length }}）
        </div>
        <div
          v-for="block in group.blocks"
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
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.block-library {
  width: 320px;
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
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
  font-weight: 600;
}

.header-ops {
  display: flex;
  align-items: center;
  gap: 6px;
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
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid #e2e3e5;
}

.tag-chip {
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
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tag-row .input {
  flex: 1;
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

.group-header {
  padding: 6px 4px 4px;
  font-size: 12px;
  font-weight: 600;
  color: #8f959e;
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
  display: block;
  font-size: 12px;
  color: #8f959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
