<script setup lang="ts">
/**
 * 绑定浮层（M6a）：区域点击后的操作面板。
 *
 * - 未绑定区域：块列表点选即绑定（PRD 4.4 反向路径）
 * - 已绑定区域：显示当前绑定块 + 可换绑（点其他块）+ 可解绑
 */

import { computed } from 'vue'
import type { Block } from '../api/blocks'
import type { DisplayRegion } from '../stores/preview'

const props = defineProps<{
  region: DisplayRegion
  blocks: Block[]
}>()

const emit = defineEmits<{
  bind: [blockId: number]
  unbind: []
  close: []
}>()

const currentBinding = computed(() =>
  props.region.binding?.status === 'active' ? props.region.binding : null,
)
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡 -->
  <div
    class="dialog-mask"
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
      <div class="block-list">
        <div
          v-if="blocks.length === 0"
          class="empty"
        >
          块库为空，请先在左侧新建字符块
        </div>
        <button
          v-for="block in blocks"
          :key="block.id"
          class="block-item"
          :class="{ current: currentBinding?.block_id === block.id }"
          @click="emit('bind', block.id)"
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
  </div>
</template>

<style scoped>
.dialog-mask {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
}

.dialog-card {
  width: min(420px, 90%);
  max-height: 70%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e2e3e5;
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.icon-btn {
  border: none;
  background: none;
  font-size: 18px;
  color: #8f959e;
  cursor: pointer;
  line-height: 1;
}

.current {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  color: #34c724;
  background: rgba(52, 199, 36, 0.08);
}

.current.missing {
  color: #e6a23c;
  background: rgba(230, 162, 60, 0.1);
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
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  text-align: left;
  cursor: pointer;
}

.block-item:hover {
  background: #f5f7fa;
  border-color: #d0d3d6;
}

.block-item.current {
  border-color: #34c724;
  background: rgba(52, 199, 36, 0.06);
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

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  padding: 8px 14px;
  border-top: 1px solid #e2e3e5;
}

.danger {
  padding: 4px 14px;
  font-size: 13px;
  color: #f54a45;
  background: none;
  border: 1px solid #f54a45;
  border-radius: 4px;
  cursor: pointer;
}
</style>
