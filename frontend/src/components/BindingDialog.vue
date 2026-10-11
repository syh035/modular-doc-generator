<script setup lang="ts">
/**
 * 绑定浮层（M6a）：区域点击后的操作面板。
 *
 * - 未绑定区域：块列表点选即绑定（PRD 4.4 反向路径）
 * - 已绑定区域：显示当前绑定块 + 可换绑（点其他块）+ 可解绑
 */

import { useModalEsc } from '../composables/useModalEsc'
import { computed, ref } from 'vue'
import { matchesBlock } from '../utils/blockSearch'
import type { Block } from '../api/blocks'
import type { DisplayRegion } from '../stores/preview'

const props = defineProps<{
  region: DisplayRegion
  blocks: Block[]
}>()

const emit = defineEmits<{
  bind: [blockId: number, lineBreakMode?: 'paragraph' | 'soft', position?: 'inside' | 'before' | 'after']
  unbind: []
  edit: []
  close: []
}>()

const currentBinding = computed(() =>
  props.region.binding?.status === 'active' ? props.region.binding : null,
)
const lineBreakMode = ref<'paragraph' | 'soft'>(props.region.binding?.line_break_mode ?? 'paragraph')
const position = ref<'inside' | 'before' | 'after'>(props.region.binding?.position ?? 'inside')
function chooseBlock(id: number): void {
  if (position.value !== 'inside') { emit('bind', id, lineBreakMode.value, position.value); return }
  if (lineBreakMode.value === 'paragraph') emit('bind', id)
  else emit('bind', id, lineBreakMode.value)
}
const query = ref('')
const tagId = ref<number | null>(null)
const tags = computed(() => [...new Map(props.blocks.flatMap(b => b.tags).map(t => [t.id, t])).values()])
const visibleBlocks = computed(() => props.blocks.filter(b => matchesBlock(b, query.value, tagId.value)))
useModalEsc(() => emit('close'))
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡 -->
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="区域绑定"
    aria-modal="true"
    tabindex="-1"
    data-testid="binding-dialog"
    @click.self="emit('close')"
  >
    <div class="dialog-card">
      <div class="dialog-head">
        <span class="title">区域：{{ region.label }}</span>
        <button
          class="icon-btn"
          aria-label="关闭"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
      <p
        v-if="currentBinding"
        class="current"
      >
        当前绑定：<strong>{{ currentBinding.block_name ?? `块 #${currentBinding.block_id}` }}</strong>
      </p>
      <p
        v-else-if="region.binding?.status === 'missing'"
        class="current missing"
      >
        原绑定块已删除（内容回落为占位符原文），请重新绑定
      </p>
      <label>多行内容<select
        v-model="lineBreakMode"
        aria-label="多行内容换行方式"
      ><option value="paragraph">换段（默认）</option><option value="soft">软回车（同段换行）</option></select></label>
      <label>绑定位置<select
        v-model="position"
        aria-label="绑定位置"
      ><option value="inside">区域内替换（默认）</option><option value="before">在段落前插入</option><option value="after">在段落后插入</option></select></label>
      <p v-if="position !== 'inside'">
        保留原段落，在其{{ position === 'before' ? '前' : '后' }}方插入字符块；空行块可用于留白。
      </p>
      <button
        v-if="currentBinding"
        class="edit-text-btn"
        @click="chooseBlock(currentBinding.block_id)"
      >
        应用排版设置
      </button>
      <button
        v-if="region.current_text !== undefined"
        class="edit-text-btn"
        data-testid="edit-region-text"
        @click="emit('edit')"
      >
        编辑文字
      </button>
      <div class="block-filters">
        <input
          v-model="query"
          data-modal-autofocus
          type="search"
          aria-label="搜索可绑定内容块"
          placeholder="搜索名称、正文或标签"
        >
        <select
          v-model="tagId"
          aria-label="按标签筛选内容块"
        >
          <option :value="null">
            全部标签
          </option><option
            v-for="tag in tags"
            :key="tag.id"
            :value="tag.id"
          >
            {{ tag.name }}
          </option>
        </select>
        <span>{{ visibleBlocks.length }} 个可选内容块</span>
      </div>
      <div class="block-list">
        <div
          v-if="blocks.length === 0"
          class="empty"
        >
          块库为空，请先在左侧新建字符块
        </div>
        <p
          v-if="blocks.length > 0 && visibleBlocks.length === 0"
          class="empty"
        >
          没有匹配的内容块
        </p>
        <button
          v-for="block in visibleBlocks"
          :key="block.id"
          class="block-item"
          :class="{ current: currentBinding?.block_id === block.id }"
          @click="chooseBlock(block.id)"
        >
          <span class="name">{{ block.name }}</span>
          <span class="content">{{ block.content }}</span>
        </button>
      </div>
      <div class="dialog-foot">
        <button
          v-if="region.binding"
          class="danger"
          @click="emit('unbind')"
        >
          解绑
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.edit-text-btn { margin-bottom: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--primary); }
.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--modal-backdrop);
}

.dialog-card {
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-radius: 8px;
  box-shadow: 0 4px 20px var(--shadow-modal);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.icon-btn {
  border: none;
  background: none;
  font-size: 18px;
  color: var(--text-3);
  cursor: pointer;
  line-height: 1;
}

.current {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--success);
  background: var(--success-bg-subtle);
}

.current.missing {
  color: var(--warning-muted);
  background: var(--warning-bg-missing);
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

.block-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  text-align: left;
  cursor: pointer;
}

.block-item:hover {
  background: var(--bg-list-hover);
  border-color: var(--border-control);
}

.block-item.current {
  border-color: var(--success);
  background: var(--success-bg-hover);
}

.name {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.content {
  display: block;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
}

.danger {
  padding: 4px 14px;
  font-size: 13px;
  color: var(--danger);
  background: none;
  border: 1px solid var(--danger);
  border-radius: 4px;
  cursor: pointer;
}
.block-filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px; border-bottom: 1px solid var(--border); }
.block-filters input { flex: 1; min-width: 150px; }
.block-filters span { flex-basis: 100%; font-size: 12px; color: var(--text-2); }
.block-item { padding: 12px; margin-bottom: 6px; border-color: var(--border); }
.block-item .content { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.5; margin-top: 6px; }
</style>
