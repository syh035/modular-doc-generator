<script setup lang="ts">
/**
 * 左栏：字符块库（M6a 最小实现——新建 + 列表 + 点选）。
 *
 * 正向绑定流：点选块高亮 → 右栏点目标区域即绑定（PRD 4.4）。
 * 标签筛选/分类编辑/删除/软删除（D11）等完整能力属 M2。
 */

import { onMounted, ref } from 'vue'
import { useBlocksStore } from '../stores/blocks'

const store = useBlocksStore()

const showForm = ref(false)
const name = ref('')
const content = ref('')
const formError = ref<string | null>(null)

async function submit(): Promise<void> {
  formError.value = null
  const ok = await store.createNewBlock(name.value.trim(), content.value)
  if (ok) {
    name.value = ''
    content.value = ''
    showForm.value = false
  } else {
    formError.value = store.createError
  }
}

onMounted(() => {
  void store.loadBlocks()
})
</script>

<template>
  <aside class="block-library">
    <div class="header">
      <span>字符块库</span>
      <button
        class="primary"
        @click="showForm = !showForm"
      >
        {{ showForm ? '收起' : '+ 新建字符块' }}
      </button>
    </div>

    <!-- 新建表单（M6a 最小：名称 + 内容；标签/分类编辑属 M2） -->
    <form
      v-if="showForm"
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
      <p
        v-if="formError"
        class="form-error"
      >
        {{ formError }}
      </p>
      <button
        type="submit"
        class="primary"
        :disabled="store.creating"
      >
        {{ store.creating ? '创建中…' : '创建' }}
      </button>
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

    <div class="block-list">
      <div
        v-if="store.blocks.length === 0 && !store.error"
        class="empty"
      >
        暂无字符块，点击上方按钮新建
      </div>
      <button
        v-for="block in store.blocks"
        :key="block.id"
        class="block-item"
        :class="{ selected: store.selectedBlockId === block.id }"
        @click="store.selectBlock(block.id)"
      >
        <span class="name">{{ block.name }}</span>
        <span class="content">{{ block.content }}</span>
      </button>
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

.name {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}

.content {
  display: block;
  font-size: 12px;
  color: #8f959e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
