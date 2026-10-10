<script setup lang="ts">
import BlockLibrary from './BlockLibrary.vue'
import { useModalEsc } from '../composables/useModalEsc'
const emit = defineEmits<{ close: [] }>()
useModalEsc(() => emit('close'))
</script>
<template>
  <dialog
    ref="modal"
    class="dialog-mask drawer-mask"
    aria-label="内容块库"
    @click.self="emit('close')"
  >
    <section class="drawer-body">
      <header>
        <span>选择内容块后，点击文档区域绑定</span><button
          class="ui-btn"
          aria-label="关闭块库"
          @click="emit('close')"
        >
          关闭
        </button>
      </header>
      <BlockLibrary @select="emit('close')" />
    </section>
  </dialog>
</template>
<style scoped>
.drawer-mask { position: fixed; inset: 0; z-index: 900; display: flex; align-items: stretch; background: var(--modal-backdrop); }
.drawer-body { width: min(400px, calc(100vw - 32px)); height: 100%; display: flex; flex-direction: column; background: var(--bg-surface); box-shadow: 4px 0 20px var(--shadow-modal); }
header { padding: 12px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); }
header span { flex: 1; font-size: 12px; color: var(--text-2); }
.drawer-body :deep(.block-library) { width: 100% !important; flex: 1; min-height: 0; border: none; }
</style>
