<script setup lang="ts">
/**
 * 校对命名弹层（M5b）：框选新建区域后命名 + 选类型。
 * 后端校验错误（REGION_FRAME_EMPTY / REGION_FRAME_MULTI）经 error prop 内联显示。
 */
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
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 BindingDialog 布局） -->
  <div
    class="dialog-mask"
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
  width: min(380px, 90%);
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

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px 0;
}

.field-label {
  font-size: 12px;
  color: #646a73;
}

.field input,
.field select {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid #d0d3d6;
  border-radius: 4px;
}

.field input:focus,
.field select:focus {
  outline: none;
  border-color: #3370ff;
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
