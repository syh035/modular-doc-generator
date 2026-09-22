<script setup lang="ts">
/**
 * 导出大超出警示弹层（M9，PRD 4.8 / D5）：
 * 存在未处理大超出时先展示清单，用户确认后仍按重排结果导出（默认行为）。
 * 警示项与 M7 状态条同口径：大超出红色，固定行高裁剪单独提示。
 */
import type { ExportWarning } from '../api/exports'

defineProps<{
  warnings: ExportWarning[]
  error: string | null
  submitting: boolean
}>()

const emit = defineEmits<{
  confirm: []
  close: []
}>()
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 VersionDialog 布局） -->
  <div
    class="dialog-mask"
    data-testid="export-dialog"
    @click.self="emit('close')"
  >
    <div class="dialog-card">
      <div class="dialog-head">
        <span class="title">大超出警示（{{ warnings.length }}）</span>
        <button
          type="button"
          class="icon-btn"
          aria-label="关闭"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
      <p class="hint">
        以下区域内容超出原区域高度较多，导出将按重排结果落盘（后续内容顺延、页面向下伸展）。
        建议返回精简内容或调整模板，也可确认后直接导出。
      </p>
      <ul class="warning-list">
        <li
          v-for="w in warnings"
          :key="w.region_id"
          class="warning-row"
        >
          <span class="name">{{ w.label ?? `区域 #${w.region_id}` }}</span>
          <span
            class="tag"
            :class="{ clipped: w.clipped }"
          >
            {{ w.clipped ? '固定行高裁剪内容' : `+${Math.round((w.ratio ?? 0) * 100)}%` }}
          </span>
        </li>
      </ul>
      <p
        v-if="error"
        class="error"
        data-testid="export-error"
      >
        {{ error }}
      </p>
      <div class="dialog-foot">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          返回修改
        </button>
        <button
          type="button"
          class="primary"
          :disabled="submitting"
          data-testid="export-confirm"
          @click="emit('confirm')"
        >
          {{ submitting ? '导出中…' : '仍要导出（重排）' }}
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

.hint {
  margin: 10px 14px 0;
  font-size: 12px;
  line-height: 1.6;
  color: #646a73;
}

.warning-list {
  margin: 8px 14px 0;
  max-height: 200px;
  overflow: auto;
  border: 1px solid #e2e3e5;
  border-radius: 4px;
}

.warning-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
}

.warning-row + .warning-row {
  border-top: 1px solid #f0f1f2;
}

.name {
  color: #1f2329;
}

.tag {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid #f54a45;
  border-radius: 3px;
  color: #f54a45;
}

.tag.clipped {
  border-color: #ff7d00;
  color: #ff7d00;
}

.error {
  margin: 8px 14px 0;
  padding: 6px 8px;
  font-size: 12px;
  color: #f54a45;
  background: rgba(245, 74, 69, 0.08);
  border-radius: 4px;
}

.dialog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
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

.primary {
  padding: 5px 14px;
  font-size: 13px;
  color: #fff;
  background: #3370ff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
