<script setup lang="ts">
import { useModalEsc } from '../composables/useModalEsc'

const props = defineProps<{ editing: boolean; busy: boolean; error: string | null; submitLabel: string }>()
const name = defineModel<string>('name', { required: true })
const content = defineModel<string>('content', { required: true })
const kind = defineModel<'text' | 'blank'>('kind', { default: 'text' })
const tags = defineModel<string>('tags', { required: true })
const emit = defineEmits<{ submit: []; close: [] }>()
useModalEsc(() => { if (!props.busy) emit('close') })
</script>

<template>
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="字符块编辑"
    @click.self="!busy && emit('close')"
  >
    <form
      class="editor-card"
      @submit.prevent="emit('submit')"
    >
      <header>
        <h2>{{ editing ? '编辑字符块' : '新建字符块' }}</h2><button
          type="button"
          class="ui-btn"
          :disabled="busy"
          aria-label="关闭块编辑"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <div class="editor-fields">
        <label>名称<input
          v-model="name"
          data-modal-autofocus
          maxlength="30"
          placeholder="1–30 字"
          required
        ></label>
        <label>类型<select
          v-model="kind"
          aria-label="字符块类型"
        ><option value="text">文字块</option><option value="blank">空行块（保留段落留白）</option></select></label>
        <label v-if="kind === 'text'">内容<textarea
          v-model="content"
          maxlength="5000"
          rows="12"
          placeholder="输入可复用的内容，保留换行"
          required
        /></label>
        <span class="hint">{{ content.length }} / 5000 字 · 换行按段落保留</span>
        <label>标签<input
          v-model="tags"
          placeholder="逗号分隔，最多 10 个"
        ></label>
        <p
          v-if="error"
          class="error"
          role="alert"
        >
          {{ error }}
        </p>
      </div>
      <footer>
        <button
          type="button"
          class="ui-btn"
          :disabled="busy"
          @click="emit('close')"
        >
          取消
        </button><button
          type="submit"
          class="ui-btn ui-primary"
          :disabled="busy || !name.trim() || (kind === 'text' && !content.trim())"
        >
          {{ submitLabel }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.dialog-mask { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop); }
.editor-card { width: min(680px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; background: var(--bg-surface); border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-modal); overflow: hidden; }
header, footer { display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; gap: 8px; }
header { border-bottom: 1px solid var(--border); } h2 { font-size: 18px; margin: 0; }
.editor-fields { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; font-weight: 600; } textarea { resize: vertical; min-height: 180px; line-height: 1.7; }
.hint { font-size: 12px; color: var(--text-2); margin-top: -8px; } .error { color: var(--danger); font-size: 13px; margin: 0; }
footer { justify-content: flex-end; border-top: 1px solid var(--border); }
</style>
