<script setup lang="ts">
/**
 * 校对命名弹层（M5b）：框选新建区域后命名 + 选类型。
 * 后端校验错误（REGION_FRAME_EMPTY / REGION_FRAME_MULTI）经 error prop 内联显示。
 */
import { useModalEsc } from '../composables/useModalEsc'
import { onMounted, ref, useTemplateRef } from 'vue'
import { REGION_TYPE_OPTIONS } from '../constants/regionTypes'

const props = defineProps<{
  embedded?: boolean
  returnToTemplate?: boolean
  error: string | null
  submitting: boolean
  initialName?: string
  initialType?: string
}>()

const emit = defineEmits<{
  submit: [label: string, type: string, continueAdding: boolean]
  reframe: [label: string, type: string]
  close: []
}>()

const label = ref(props.initialName ?? '补选区域1')
const type = ref(props.initialType ?? 'custom')

function onSubmit(continueAdding = false): void {
  const name = label.value.trim()
  if (props.submitting || name.length === 0 || name.length > 50) {
    return // 前端先行拦截，后端 _validate_label 同口径
  }
  emit('submit', name, type.value, continueAdding)
}
function close(): void { if (!props.submitting) emit('close') }
function reframe(): void { if (!props.submitting) emit('reframe', label.value, type.value) }
if (!props.embedded) useModalEsc(close)
const panel = useTemplateRef<HTMLElement>('panel')
onMounted(() => { if (props.embedded) panel.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) })
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 BindingDialog 布局） -->
  <component
    :is="embedded ? 'section' : 'dialog'"
    ref="modal"
    class="dialog-mask"
    :class="{ embedded }"
    aria-label="添加可编辑区域"
    :aria-modal="embedded ? undefined : true"
    tabindex="-1"
    data-testid="region-name-dialog"
    @keydown.esc.stop.prevent="close"
    @click.self="close"
  >
    <form
      ref="panel"
      class="dialog-card"
      @submit.prevent="onSubmit(false)"
    >
      <div class="dialog-head">
        <span class="title">添加可编辑区域</span>
        <button
          type="button"
          class="icon-btn"
          aria-label="关闭"
          :disabled="submitting"
          @click="close"
        >
          ×
        </button>
      </div>
      <label class="field">
        <span class="field-label">区域名称</span>
        <input
          v-model="label"
          :disabled="submitting"
          data-modal-autofocus
          maxlength="50"
          placeholder="如：姓名、工作经历一（1–50 字）"
          data-testid="region-name-input"
        >
      </label>
      <details class="type-options">
        <summary
          :aria-disabled="submitting"
          @click="submitting && $event.preventDefault()"
        >
          区域类型（可选）
        </summary>
        <label class="field">
          <span class="field-label">区域类型</span>
          <select
            v-model="type"
            :disabled="submitting"
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
      </details>
      <p
        v-if="error"
        class="error"
        data-testid="region-name-error"
      >
        {{ error }}
      </p>
      <div class="dialog-foot">
        <button
          v-if="error"
          type="button"
          class="ghost"
          :disabled="submitting"
          data-testid="reframe-region"
          @click="reframe"
        >
          重新框选
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="submitting"
          @click="close"
        >
          取消
        </button>
        <button
          type="button"
          class="ghost"
          :disabled="submitting || label.trim().length === 0"
          @click="onSubmit(true)"
        >
          保存并继续添加
        </button>
        <button
          type="submit"
          class="primary"
          :disabled="submitting || label.trim().length === 0"
        >
          {{ submitting ? '正在保存…' : returnToTemplate ? '保存并返回模板' : '保存并返回文档' }}
        </button>
      </div>
    </form>
  </component>
</template>

<style scoped>
.dialog-mask.embedded { position: static; background: none; display: block; margin: 10px 0; }
.embedded .dialog-card { width: 100%; box-shadow: none; border: 1px solid var(--border); }
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
.type-options { margin: 10px 14px; font-size: 12px; color: var(--text-2); }
.type-options summary { cursor: pointer; }
.type-options .field { padding: 10px 0 0; }

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
  flex-wrap: wrap;
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
@media (max-width: 480px) {
  .dialog-foot > .primary { flex-basis: 100%; }
  .dialog-foot > .ghost { flex: 1; white-space: nowrap; }
}
</style>
