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
      <BlockLibrary
        drawer
        @select="emit('close')"
        @close="emit('close')"
      />
    </section>
  </dialog>
</template>
<style scoped>
.drawer-mask { position: fixed; inset: 0; z-index: 900; display: flex; align-items: stretch; background: var(--modal-backdrop); }
.drawer-body { width: min(400px, calc(100vw - 32px)); height: 100%; display: flex; flex-direction: column; background: var(--bg-surface); box-shadow: 4px 0 20px var(--shadow-modal); }
.drawer-body :deep(.block-library) { width: 100% !important; flex: 1; min-height: 0; border: none; }
</style>
