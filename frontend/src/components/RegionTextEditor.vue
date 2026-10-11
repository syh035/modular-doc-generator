<script setup lang="ts">
import { computed, ref } from 'vue'
import { useModalEsc } from '../composables/useModalEsc'
import type { DisplayRegion } from '../stores/preview'
const props = defineProps<{ region: DisplayRegion; submitting: boolean; error: string | null }>()
const emit = defineEmits<{ save: [content: string, syncBlock: boolean]; remove: []; close: [] }>()
const content = ref(props.region.current_text ?? '')
const syncBlock = ref(false)
const valid = computed(() => content.value.trim().length > 0 && content.value.length <= 5000
  && content.value !== props.region.current_text)
function close(): void { if (!props.submitting) emit('close') }
useModalEsc(close)
</script>

<template>
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="编辑区域文字"
    aria-modal="true"
    tabindex="-1"
    data-testid="region-text-editor"
    @click.self="close"
  >
    <form
      class="dialog-card"
      @submit.prevent="valid && !submitting && emit('save', content, syncBlock)"
    >
      <div class="dialog-head">
        <h2>编辑文字 · {{ region.label }}</h2>
        <button
          type="button"
          aria-label="关闭文字编辑"
          :disabled="submitting"
          @click="close"
        >
          ×
        </button>
      </div>
      <p>修改当前内容版本，保留模板原件和段落样式。</p>
      <label>区域文字
        <textarea
          v-model="content"
          data-modal-autofocus
          rows="10"
          :disabled="submitting"
          maxlength="5000"
          aria-label="区域文字"
        />
      </label>
      <div class="text-count">
        {{ content.length }} / 5000 字
      </div>
      <label
        v-if="region.binding?.status === 'active'"
        class="sync-option"
      >
        <input
          v-model="syncBlock"
          type="checkbox"
          :disabled="submitting"
        >
        同步修改原字符块「{{ region.binding.block_name }}」
      </label>
      <p class="hint">
        {{ syncBlock ? '所有引用该字符块的版本都会使用新内容。' : '保存为字符块并用于当前版本，其他版本保留原内容。' }}
      </p>
      <p
        v-if="error"
        role="alert"
        class="error"
      >
        {{ error }}
      </p>
      <p class="hint">
        删除会移除当前版本中该区域所属的整段文字；同段的其他区域也会一并隐藏，可在预览的“已删除段落”恢复。
      </p>
      <div class="actions">
        <button
          type="button"
          :disabled="submitting"
          @click="emit('remove')"
        >
          删除本版本段落
        </button>
        <button
          type="button"
          :disabled="submitting"
          @click="close"
        >
          取消
        </button>
        <button
          type="submit"
          :disabled="!valid || submitting"
        >
          {{ submitting ? '正在保存…' : '保存并更新预览' }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.dialog-mask { position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; border: none; padding: 20px; background: transparent; }
.dialog-mask::backdrop { background: var(--modal-backdrop); }
.dialog-card { width: min(620px, 100%); max-height: calc(100vh - 40px); overflow: auto; margin: auto; padding: 24px; background: var(--bg-surface); color: var(--text-1); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); }
.dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
h2 { font-size: 18px; margin: 0; }
p { color: var(--text-2); line-height: 1.5; }
textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 12px; resize: vertical; font: inherit; line-height: 1.6; border: 1px solid var(--border); border-radius: 6px; }
.text-count { text-align: right; color: var(--text-3); font-size: 12px; margin: 6px 0 12px; }
.sync-option { display: flex; gap: 8px; align-items: center; }
.hint { font-size: 13px; }
.error { color: var(--danger); }
.actions { display: flex; justify-content: flex-end; gap: 10px; }
button { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; }
button[type=submit] { background: var(--primary); color: var(--text-on-primary); }
button:disabled { opacity: .5; cursor: default; }
</style>
