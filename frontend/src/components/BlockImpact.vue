<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { apiFetch } from '../api/client'
export interface BlockUsage {
  versions: { id: number; name: string; template_name: string; region_count: number }[]
  templates: { id: number; filename: string }[]
}
const props = defineProps<{ blockId: number }>()
const emit = defineEmits<{ loaded: [usage: BlockUsage | null] }>()
const usage = ref<BlockUsage | null>(null)
const error = ref('')
let sequence = 0
watch(() => props.blockId, async id => {
  const seq = ++sequence
  usage.value = null; error.value = ''; emit('loaded', null)
  try {
    const result = await apiFetch<BlockUsage>(`/api/blocks/${id}/usage`)
    if (!Array.isArray(result.versions) || !Array.isArray(result.templates)) throw new Error('引用信息不完整，请重新打开')
    if (seq !== sequence) return
    usage.value = result; emit('loaded', result)
  } catch (err) { if (seq === sequence) error.value = String(err) }
}, { immediate: true })
onBeforeUnmount(() => { sequence++ })
</script>

<template>
  <div
    class="block-impact"
    @click.stop
  >
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <p v-else-if="!usage">
      正在核对影响范围…
    </p>
    <template v-else>
      <p>此块属于 {{ usage.templates.length }} 个模板，被 {{ usage.versions.length }} 个内容版本使用。冻结归档保留原稿。</p>
      <ul v-if="usage.versions.length">
        <li
          v-for="version in usage.versions"
          :key="version.id"
        >
          {{ version.template_name }} · {{ version.name }}（{{ version.region_count }} 处）
        </li>
      </ul>
      <details v-if="usage.templates.length">
        <summary>所属模板</summary><p>{{ usage.templates.map(t => t.filename).join('、') }}</p>
      </details>
    </template>
  </div>
</template>

<style scoped>
.block-impact { padding: 10px; margin: 8px 0; background: var(--bg-hover); border-radius: 6px; font-size: 12px; font-weight: normal; line-height: 1.6; color: var(--text-2); }
p { margin: 0; } ul { margin: 6px 0; padding-left: 18px; max-height: 150px; overflow: auto; } details { margin-top: 6px; }
</style>
