<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Block } from '../api/blocks'
import { useModalEsc } from '../composables/useModalEsc'
import { matchesBlock } from '../utils/blockSearch'
const props = defineProps<{ blocks: Block[]; memberIds: number[]; busy: boolean; error: string | null }>()
const emit = defineEmits<{ add: [id: number]; close: [] }>()
const query = ref('')
const visible = computed(() => props.blocks.filter(b => matchesBlock(b, query.value)))
useModalEsc(() => { if (!props.busy) emit('close') })
</script>

<template>
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="共享字符块"
    @click.self="!busy && emit('close')"
  >
    <section class="shared-card">
      <header>
        <h2>共享块</h2><button
          class="ui-btn"
          :disabled="busy"
          aria-label="关闭共享块"
          @click="emit('close')"
        >
          ×
        </button>
      </header>
      <p>从全局资产库加入当前模板，复用同一字符块。编辑或删除共享块会影响所有使用它的模板。</p>
      <label>搜索共享块<input
        v-model="query"
        type="search"
        data-modal-autofocus
        placeholder="名称、正文或标签"
      ></label>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="shared-list">
        <p v-if="visible.length === 0">
          暂无可共享的字符块
        </p>
        <article
          v-for="block in visible"
          :key="block.id"
        >
          <div>
            <strong>{{ block.name }}</strong><p class="content">
              {{ block.kind === 'blank' ? '空行块' : block.content }}
            </p>
          </div>
          <button
            class="ui-btn"
            :disabled="busy || memberIds.includes(block.id)"
            @click="emit('add', block.id)"
          >
            {{ memberIds.includes(block.id) ? '已加入' : '加入当前模板' }}
          </button>
        </article>
      </div>
      <footer>
        <button
          class="ui-btn"
          :disabled="busy"
          @click="emit('close')"
        >
          完成
        </button>
      </footer>
    </section>
  </dialog>
</template>

<style scoped>
.dialog-mask { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop); }
.shared-card { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); display: flex; flex-direction: column; background: var(--bg-surface); border-radius: 12px; padding: 20px; gap: 14px; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; } h2, p { margin: 0; } p { font-size: 13px; color: var(--text-2); line-height: 1.6; }
label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; } .shared-list { overflow: auto; } article { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border); } article > div { min-width: 0; } button { flex-shrink: 0; }
.content { white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; } .error { color: var(--danger); } footer { justify-content: flex-end; }
</style>
