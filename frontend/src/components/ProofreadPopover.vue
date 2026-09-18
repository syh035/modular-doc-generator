<script setup lang="ts">
/**
 * 校对操作浮层（M5b）：校对模式下区域点击后的操作面板。
 * 按钮组随 review_status 变化（PRD 4.3 状态流转）：
 * pending → 确认/排除/微调/删除；confirmed → 重新校对/微调/删除；excluded → 重新校对/删除。
 */
import { computed } from 'vue'
import { REVIEW_STATUS_LABELS } from '../constants/regionTypes'
import type { DisplayRegion } from '../stores/preview'

const props = defineProps<{
  region: DisplayRegion
}>()

const emit = defineEmits<{
  confirm: []
  exclude: []
  reopen: []
  adjust: []
  remove: []
  close: []
}>()

const status = computed(() => props.region.review_status)
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 BindingDialog 布局） -->
  <div
    class="dialog-mask"
    data-testid="proofread-popover"
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
      <p class="meta">
        状态：<strong>{{ REVIEW_STATUS_LABELS[status] ?? status }}</strong>
        <span
          v-if="region.placeholder"
          class="placeholder"
        >占位符 {{ region.placeholder }}</span>
      </p>
      <div class="actions">
        <template v-if="status === 'pending'">
          <button
            class="primary"
            data-testid="proofread-confirm"
            @click="emit('confirm')"
          >
            确认
          </button>
          <button
            class="ghost"
            data-testid="proofread-exclude"
            @click="emit('exclude')"
          >
            排除
          </button>
        </template>
        <button
          v-else
          class="ghost"
          data-testid="proofread-reopen"
          @click="emit('reopen')"
        >
          重新校对
        </button>
        <button
          v-if="status !== 'excluded'"
          class="ghost"
          data-testid="proofread-adjust"
          @click="emit('adjust')"
        >
          微调边界
        </button>
        <button
          class="danger"
          data-testid="proofread-remove"
          @click="emit('remove')"
        >
          删除
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
  width: min(340px, 90%);
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

.meta {
  margin: 0;
  padding: 8px 14px;
  font-size: 12px;
  color: #646a73;
}

.meta strong {
  color: #1f2329;
}

.placeholder {
  margin-left: 8px;
  color: #8f959e;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 14px 14px;
}

.primary {
  padding: 5px 14px;
  font-size: 13px;
  color: #fff;
  background: #3370ff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.ghost {
  padding: 5px 14px;
  font-size: 13px;
  color: #646a73;
  background: none;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
  cursor: pointer;
}

.danger {
  padding: 5px 14px;
  font-size: 13px;
  color: #f54a45;
  background: none;
  border: 1px solid #f54a45;
  border-radius: 4px;
  cursor: pointer;
}
</style>
