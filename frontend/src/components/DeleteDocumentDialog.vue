<script setup lang="ts">
import { useModalEsc } from '../composables/useModalEsc'
import { ref, watch } from 'vue'
const props = defineProps<{ name: string; busy: boolean; error: string | null }>()
const emit = defineEmits<{ confirm: []; close: [] }>()
const cancelButton = ref<HTMLButtonElement | null>(null)
watch(() => props.busy, (busy, wasBusy) => {
  if (wasBusy && !busy && props.error) cancelButton.value?.focus({ preventScroll: true })
}, { flush: 'post' })
function close(): void { if (!props.busy) emit('close') }
useModalEsc(close)
</script>

<template>
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="删除文稿"
    @click.self="close"
  >
    <section class="dialog-card">
      <h2>删除文稿</h2>
      <p>永久删除“{{ name }}”及其填写内容和排版？模板、素材和已有归档保留。</p>
      <p class="hint">
        此操作无法撤销。
      </p>
      <p
        v-if="error"
        role="alert"
        class="error"
      >
        {{ error }}
      </p>
      <footer>
        <button
          ref="cancelButton"
          class="ui-btn"
          data-modal-autofocus
          :disabled="busy"
          @click="close"
        >
          取消
        </button>
        <button
          class="ui-btn ui-danger"
          :disabled="busy"
          @click="!busy && emit('confirm')"
        >
          {{ busy ? '删除中…' : '确认删除文稿' }}
        </button>
      </footer>
    </section>
  </dialog>
</template>

<style scoped>
.dialog-mask { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop); }
.dialog-card { width: min(440px, calc(100vw - 32px)); padding: 22px; background: var(--bg-surface); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); overflow-wrap: anywhere; }
h2 { font-size: 18px; margin-bottom: 14px; } p { font-size: 13px; line-height: 1.8; } .hint { margin-top: 8px; color: var(--text-2); } .error { color: var(--danger); margin-top: 12px; }
footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
</style>
