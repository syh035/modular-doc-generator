<script setup lang="ts">
/**
 * 校对命名弹层（M5b）：框选新建区域后命名 + 选类型。
 * 后端校验错误（REGION_FRAME_EMPTY / REGION_FRAME_MULTI）经 error prop 内联显示。
 */
import { useModalEsc } from '../composables/useModalEsc'
import { ref } from 'vue'
import { REGION_TYPE_OPTIONS } from '../constants/regionTypes'

defineProps<{
  error: string | null
  submitting: boolean
}>()

const emit = defineEmits<{
  submit: [label: string, type: string]
  close: []
}>()

const label = ref('')
const type = ref('custom')

function onSubmit(): void {
  const name = label.value.trim()
  if (name.length === 0 || name.length > 50) {
    return // 前端先行拦截，后端 _validate_label 同口径
  }
  emit('submit', name, type.value)
}
useModalEsc(() => emit('close'))
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 BindingDialog 布局） -->
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="新建区域"
    aria-modal="true"
    tabindex="-1"
    data-testid="region-name-dialog"
    @click.self="emit('close')"
  >
    <form
      class="dialog-card"
      @submit.prevent="onSubmit"
    >
      <div class="dialog-head">
        <span class="title">新建区域</span>
        <button
          type="button"
          class="icon-btn"
          aria-label="关闭"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
      <label class="field">
        <span class="field-label">区域名称</span>
        <input
          v-model="label"
          data-modal-autofocus
          maxlength="50"
          placeholder="如：姓名、工作经历一（1–50 字）"
          data-testid="region-name-input"
        >
      </label>
      <label class="field">
        <span class="field-label">区域类型</span>
        <select
          v-model="type"
          data-testid="region-type-select"
        >
          <option
            v-for="opt in REGION_TYPE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </label>
      <p
        v-if="error"
        class="error"
        data-testid="region-name-error"
      >
        {{ error }}
      </p>
      <div class="dialog-foot">
        <button
          type="button"
          class="ghost"
          @click="emit('close')"
        >
          取消
        </button>
        <button
          type="submit"
          class="primary"
          :disabled="submitting || label.trim().length === 0"
        >
          {{ submitting ? '创建中…' : '创建' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
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
  width: min(380px, 90%);
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

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px 0;
}

.field-label {
  font-size: 12px;
  color: var(--text-2);
}

.field input,
.field select {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--border-control);
  border-radius: 4px;
}

.field input:focus,
.field select:focus {
  outline: none;
  border-color: var(--primary);
}

.error {
  margin: 8px 14px 0;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-bg-subtle);
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
  color: var(--text-2);
  background: none;
  border: 1px solid var(--border-control);
  border-radius: 4px;
  cursor: pointer;
}

.primary {
  padding: 5px 14px;
  font-size: 13px;
  color: var(--text-on-primary);
  background: var(--primary);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
