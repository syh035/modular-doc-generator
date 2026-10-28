<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { apiFetch } from '../api/client'
import type { MaterialSelection, MaterialReference } from '../api/blocks'
const props = defineProps<{ blockId: number; deleting?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ change: [value: MaterialSelection | null] }>()
const fields = ref<(MaterialReference & { document_name: string; template_name: string; label: string })[]>([])
const selected = ref<MaterialReference[]>([])
const token = ref(''), error = ref(''), loading = ref(false)
let request = 0
function publish(): void { emit('change', { token: token.value, selected: selected.value }) }
async function load(): Promise<void> {
  const seq = ++request
  loading.value = true; error.value = ''; selected.value = []; token.value = ''; emit('change', null)
  try {
    const result = await apiFetch<{ fields: typeof fields.value; token: string }>(`/api/blocks/${props.blockId}/references`)
    if (seq !== request) return
    if (!Array.isArray(result.fields) || !result.token) throw new Error('引用信息不完整，请重新核对')
    fields.value = result.fields; token.value = result.token; publish()
  } catch (err) { if (seq === request) error.value = err instanceof Error ? err.message : String(err) }
  finally { if (seq === request) loading.value = false }
}
function key(field: MaterialReference): string { return `${field.kind}:${field.version_id}:${field.id}` }
function toggle(field: MaterialReference): void {
  selected.value = selected.value.some(f => key(f) === key(field)) ? selected.value.filter(f => key(f) !== key(field))
    : [...selected.value, { kind: field.kind, version_id: field.version_id, id: field.id }]
  publish()
}
watch(() => props.blockId, () => { void load() }, { immediate: true })
onBeforeUnmount(() => { request++ })
</script>
<template>
  <section
    class="material-scope"
    aria-label="同步到引用字段"
  >
    <p>默认保留文稿原文。仅勾选需要同步{{ deleting ? '删除' : '更新' }}的字段；个性化副本不在此列。</p>
    <p v-if="deleting">
      勾选字段将留空并高亮，导出和归档前提醒补全；未勾选字段保留文字并解除素材关联。
    </p>
    <p
      v-if="loading"
      role="status"
    >
      正在核对实际引用…
    </p>
    <p
      v-else-if="error"
      role="alert"
    >
      {{ error }} <button
        type="button"
        :disabled="disabled"
        @click="load"
      >
        重新核对
      </button>
    </p>
    <template v-else>
      <p v-if="!fields.length">
        没有仍在引用此素材的字段。
      </p>
      <label
        v-for="field in fields"
        :key="key(field)"
      >
        <input
          type="checkbox"
          :disabled="disabled"
          :checked="selected.some(f => key(f) === key(field))"
          @change="toggle(field)"
        >
        <span>{{ field.document_name }} · {{ field.label }}<small>{{ field.template_name }}</small></span>
      </label>
      <button
        type="button"
        :disabled="disabled"
        @click="load"
      >
        重新核对引用（清除勾选）
      </button>
      <small v-if="fields.length">已选择 {{ selected.length }}/{{ fields.length }} 处；只改名称或标签不会解除引用。</small>
    </template>
  </section>
</template>
<style scoped>
.material-scope { margin: 8px 0; padding: 10px; background: var(--bg-hover); border-radius: 6px; font-size: 12px; line-height: 1.6; max-height: 240px; overflow: auto; }
p { margin: 0 0 8px; color: var(--text-2); } label { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; } small { display: block; color: var(--text-3); }
</style>
