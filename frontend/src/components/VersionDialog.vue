<script setup lang="ts">
/**
 * 版本弹层（M8）：新建（空白 / 复制当前为底稿）与重命名共用。
 * 后端校验错误（VERSION_INVALID / VERSION_NAME_TAKEN）经 error prop 内联显示。
 */
import { useModalEsc } from '../composables/useModalEsc'
import { ref } from 'vue'

const props = defineProps<{
  copyMode?: 'copy' | 'blank'
  mode: 'create' | 'rename'
  initialName: string
  canCopy: boolean
  error: string | null
  submitting: boolean
}>()

const emit = defineEmits<{
  submit: [name: string, copyFrom: boolean]
  close: []
}>()

const name = ref(props.initialName)
const copyFrom = ref(props.copyMode !== 'blank')

function onSubmit(): void {
  const trimmed = name.value.trim()
  if (trimmed.length === 0 || trimmed.length > 30) {
    return // 前端先行拦截，后端 VERSION_INVALID 同口径（名称 1–30 字符）
  }
  emit('submit', trimmed, props.mode === 'create' ? copyFrom.value : false)
}
useModalEsc(() => emit('close'))
</script>

<template>
  <!-- 遮罩：点击关闭；卡片阻止冒泡（复用 RegionNameDialog 布局） -->
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="内容版本"
    aria-modal="true"
    tabindex="-1"
    data-testid="version-dialog"
    @click.self="emit('close')"
  >
    <form
      class="dialog-card"
      @submit.prevent="onSubmit"
    >
      <div class="dialog-head">
        <span class="title">{{ mode === 'create' ? '新建内容版本' : '重命名版本' }}</span>
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
        <span class="field-label">版本名称</span>
        <input
          v-model="name"
          data-modal-autofocus
          maxlength="30"
          :placeholder="mode === 'create' ? '如：投递A岗（1–30 字）' : '版本名称（1–30 字）'"
          data-testid="version-name-input"
        >
      </label>
      <label
        v-if="mode === 'create' && canCopy && !copyMode"
        class="copy-row"
      >
        <input
          v-model="copyFrom"
          type="checkbox"
          data-testid="version-copy-checkbox"
        >
        <span>复制当前版本的绑定内容为底稿</span>
      </label>
      <p
        v-if="mode === 'create' && copyMode"
        class="copy-row"
      >
        {{ copyMode === 'copy' ? '复制所选版本的绑定内容，作为新版本底稿。' : '创建空白内容版本，保留模板版式。' }}
      </p>
      <p
        v-if="error"
        class="error"
        data-testid="version-error"
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
          :disabled="submitting || name.trim().length === 0"
        >
          {{ submitting ? '保存中…' : mode === 'create' ? '创建' : '保存' }}
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

.field input {
  padding: 6px 8px;
  font-size: 13px;
  border: 1px solid var(--border-control);
  border-radius: 4px;
}

.field input:focus {
  outline: none;
  border-color: var(--primary);
}

.copy-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px 0;
  font-size: 12px;
  color: var(--text-1);
  cursor: pointer;
}

.copy-row input {
  accent-color: var(--primary);
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
