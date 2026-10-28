<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DisplayRegion } from '../stores/preview'
import { usePreviewStore } from '../stores/preview'
import { useBlocksStore } from '../stores/blocks'
import { apiFetch } from '../api/client'
import { matchesBlock } from '../utils/blockSearch'
import type { MaterialSelection } from '../api/blocks'
import MaterialScope from './MaterialScope.vue'
const props = defineProps<{ region: DisplayRegion }>()
const emit = defineEmits<{ close: []; select: [id: number] }>()
const preview = usePreviewStore(), blocks = useBlocksStore()
const versionId = preview.currentVersionId, templateId = preview.currentTemplateId
const field = props.region.field_ref ?? { kind: 'region' as const, id: props.region.id }
const materialKey = crypto.randomUUID()
const content = ref(props.region.current_text ?? '')
const mode = ref(props.region.binding?.line_break_mode ?? 'paragraph')
const panel = ref<HTMLElement | null>(null)
const page = ref<'edit' | 'pick' | 'material'>('edit')
const query = ref(''), materialName = ref(props.region.label.slice(0, 30)), tags = ref('')
const sync = ref(false), scope = ref<MaterialSelection | null>(null)
const busy = ref(false), error = ref(''), removeConfirm = ref(false), savedNeedsRefresh = ref(false)
const visible = computed(() => blocks.blocks.filter(b => matchesBlock(b, query.value)))
const missing = computed(() => props.region.binding?.status === 'missing' && props.region.binding.missing_policy === 'blank')
const dirty = computed(() => content.value !== (props.region.current_text ?? '') || mode.value !== (props.region.binding?.line_break_mode ?? 'paragraph'))
const canSave = computed(() => content.value.length <= 5000 && (field.kind === 'insertion' || !!content.value.trim())
  && (content.value !== (props.region.current_text ?? '') || mode.value !== (props.region.binding?.line_break_mode ?? 'paragraph'))
  && (!sync.value || !!scope.value))
let disposed = false
function current(): boolean { return !disposed && preview.currentVersionId === versionId && preview.currentTemplateId === templateId }
function close(): void { if (!busy.value) emit('close') }
onMounted(() => { panel.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); void blocks.loadBlocks() })
onBeforeUnmount(() => { disposed = true })
async function run(write: () => Promise<unknown>, selected?: (result: unknown) => number): Promise<void> {
  if (busy.value || versionId === null) return
  busy.value = true; error.value = ''
  try {
    const result = await write()
    if (!current()) return
    savedNeedsRefresh.value = true
    await preview.refreshVersionRender()
    await blocks.loadBlocks()
    if (!current()) return
    if (preview.error) { error.value = `修改已保存，预览未能刷新：${preview.error}`; return }
    savedNeedsRefresh.value = false
    if (selected) emit('select', selected(result))
    else emit('close')
  } catch (err) { if (current()) error.value = err instanceof Error ? err.message : String(err) }
  finally { busy.value = false }
}
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function save(): Promise<void> {
  if (!canSave.value) return
  await run(() => {
    if (sync.value && scope.value && props.region.binding) return apiFetch(`/api/blocks/${props.region.binding.block_id}/scoped`, json({ action: 'update', content: content.value, ...scope.value }))
    if (field.kind === 'insertion') return apiFetch(`/api/versions/${versionId}/insertions/${field.id}`, json({ content: content.value, expected_content: props.region.current_text ?? '', line_break_mode: mode.value }, 'PUT'))
    return apiFetch(`/api/versions/${versionId}/regions/${field.id}/text`, json({ content: content.value, sync_block: false, expected_content: props.region.current_text ?? '', line_break_mode: mode.value }))
  })
}
async function choose(blockId: number): Promise<void> {
  await run(() => field.kind === 'insertion'
    ? apiFetch(`/api/versions/${versionId}/insertions/${field.id}`, json({ block_id: blockId, line_break_mode: mode.value, expected_content: props.region.current_text ?? '' }, 'PUT'))
    : apiFetch(`/api/versions/${versionId}/bindings`, json({ region_id: field.id, block_id: blockId, line_break_mode: mode.value })))
}
async function insert(side: 'before' | 'after'): Promise<void> {
  if (dirty.value) return
  await run(() => apiFetch<{ id: number }>(`/api/versions/${versionId}/insertions`, json({ ...field, side })), result => -(result as { id: number }).id)
}
async function remove(): Promise<void> {
  await run(() => field.kind === 'insertion'
    ? apiFetch(`/api/versions/${versionId}/insertions/${field.id}`, { method: 'DELETE' })
    : apiFetch(`/api/versions/${versionId}/regions/${field.id}/layout`, json({ action: 'remove' })))
}
async function createMaterial(): Promise<void> {
  if (!materialName.value.trim() || !content.value.trim()) return
  await run(() => apiFetch('/api/blocks/from-field', json({ name: materialName.value.trim(), content: content.value,
    line_break_mode: mode.value,
    idempotency_key: materialKey, tags: [...new Set(tags.value.split(/[,，、]/).map(t => t.trim()).filter(Boolean))], version_id: versionId,
    field: { ...field, version_id: versionId }, expected_content: props.region.current_text ?? '' })))
}
async function retryRefresh(): Promise<void> {
  if (busy.value) return
  busy.value = true
  await preview.refreshVersionRender(); busy.value = false
  if (current() && !preview.error) emit('close')
  else error.value = preview.error ?? '预览未能刷新'
}
async function switchPage(next: typeof page.value): Promise<void> {
  if (busy.value) return
  page.value = next
  await nextTick()
  panel.value?.querySelector<HTMLElement>(next === 'edit' ? 'textarea' : 'input')?.focus({ preventScroll: true })
}
</script>
<template>
  <aside
    ref="panel"
    class="field-editor"
    aria-label="文稿字段编辑"
    @keydown.esc.stop.prevent="page === 'edit' ? close() : switchPage('edit')"
  >
    <header>
      <strong>{{ region.label }}</strong><button
        type="button"
        :disabled="busy"
        aria-label="关闭字段编辑"
        @click="close"
      >
        关闭
      </button>
    </header>
    <p
      v-if="missing"
      class="missing"
      role="status"
    >
      素材已删除，待补内容。此处将留空，输出前会提醒。
    </p>
    <p
      v-if="region.binding?.status === 'active'"
      class="scope"
    >
      {{ region.binding.is_material ? '正在引用素材：' : '当前文稿的独立文字：' }}{{ region.binding.block_name }}
    </p>
    <p class="scope">
      {{ sync ? '更新素材：仅同步勾选字段' : '只编辑当前文稿，其他文稿保留原文' }}
    </p>
    <form
      v-if="page === 'edit'"
      @submit.prevent="save"
    >
      <label>文字<textarea
        v-model="content"
        aria-label="区域文字"
        rows="9"
        maxlength="5000"
        :disabled="busy || savedNeedsRefresh"
      /></label>
      <small>{{ content.length }}/5000 字</small>
      <div class="material-actions">
        <button
          type="button"
          :disabled="busy || savedNeedsRefresh || !content.trim()"
          @click="switchPage('material')"
        >
          设定为素材
        </button>
        <button
          type="button"
          :disabled="busy || savedNeedsRefresh"
          @click="switchPage('pick')"
        >
          选用素材
        </button>
      </div>
      <details>
        <summary>插入与排版</summary>
        <div class="material-actions">
          <button
            type="button"
            :disabled="busy || savedNeedsRefresh || dirty"
            @click="insert('before')"
          >
            上方插入空行
          </button><button
            type="button"
            :disabled="busy || savedNeedsRefresh || dirty"
            @click="insert('after')"
          >
            下方插入空行
          </button>
        </div>
        <p v-if="dirty">
          先保存当前修改，再插入空行。
        </p>
        <label>换行方式<select
          v-model="mode"
          :disabled="busy || savedNeedsRefresh || sync"
        ><option value="paragraph">换段落</option><option value="soft">软回车</option></select></label>
        <button
          type="button"
          :disabled="busy || savedNeedsRefresh"
          @click="removeConfirm = true"
        >
          {{ field.kind === 'insertion' ? '删除此插入行' : '删除当前稿的这一段' }}
        </button>
        <p
          v-if="removeConfirm"
          class="remove-confirm"
        >
          {{ field.kind === 'insertion' ? '仅删除这一行。' : '同段的其他字段也会隐藏，可从“已删除段落”恢复。' }}<button
            type="button"
            :disabled="busy"
            @click="removeConfirm = false"
          >
            取消
          </button><button
            type="button"
            :disabled="busy"
            @click="remove"
          >
            确认删除
          </button>
        </p>
      </details>
      <label
        v-if="region.binding?.status === 'active' && region.binding.is_material"
        class="check"
      ><input
        v-model="sync"
        type="checkbox"
        :disabled="busy || savedNeedsRefresh || mode !== (region.binding?.line_break_mode ?? 'paragraph')"
      >同时更新素材“{{ region.binding.block_name }}”</label>
      <MaterialScope
        v-if="sync && region.binding"
        :block-id="region.binding.block_id"
        :disabled="busy"
        @change="scope = $event"
      />
      <button
        type="submit"
        class="primary"
        :disabled="busy || savedNeedsRefresh || !canSave"
      >
        {{ busy ? '正在保存…' : '保存并更新预览' }}
      </button>
    </form>
    <section
      v-else-if="page === 'pick'"
      aria-label="选用素材"
    >
      <button
        :disabled="busy"
        @click="switchPage('edit')"
      >
        返回编辑（保留未保存文字）
      </button>
      <label>搜索素材<input
        v-model="query"
        aria-label="搜索素材"
        placeholder="名称、文字或标签"
        :disabled="busy"
      ></label>
      <p
        v-if="blocks.error"
        role="alert"
      >
        {{ blocks.error }} <button @click="blocks.loadBlocks">
          重试
        </button>
      </p>
      <p v-if="!visible.length">
        没有匹配素材，可返回将当前文字设定为素材。
      </p>
      <button
        v-for="block in visible"
        :key="block.id"
        class="material-item"
        :disabled="busy"
        @click="choose(block.id)"
      >
        <strong>{{ block.name }}</strong><span>{{ block.kind === 'blank' ? '空行' : block.content }}</span><small>{{ block.tags.map(t => t.name).join(' · ') }}</small>
      </button>
    </section>
    <form
      v-else
      aria-label="设定为素材"
      @submit.prevent="createMaterial"
    >
      <button
        type="button"
        :disabled="busy"
        @click="switchPage('edit')"
      >
        返回编辑
      </button>
      <p>新建素材并用于当前字段。原有素材不会被覆盖。</p>
      <label>素材名称<input
        v-model="materialName"
        required
        maxlength="30"
        :disabled="busy"
      ></label>
      <label>标签<input
        v-model="tags"
        placeholder="逗号分隔"
        :disabled="busy"
      ></label>
      <p class="material-text">
        {{ content }}
      </p>
      <button
        class="primary"
        :disabled="busy || !materialName.trim() || !content.trim()"
      >
        保存为新素材并使用
      </button>
    </form>
    <p
      v-if="error"
      role="alert"
      class="error"
    >
      {{ error }}
    </p>
    <button
      v-if="savedNeedsRefresh"
      :disabled="busy"
      @click="retryRefresh"
    >
      仅重试刷新预览
    </button>
  </aside>
</template>
<style scoped>
.field-editor { flex: 0 0 330px; min-width: 0; width: 330px; padding: 16px; overflow: auto; background: var(--bg-surface); border-left: 1px solid var(--border); color: var(--text-1); font-size: 13px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 10px; } header strong { overflow-wrap: anywhere; }
p { line-height: 1.65; margin: 10px 0; } .scope, small { color: var(--text-2); } label { display: block; margin: 12px 0; }
textarea, input:not([type=checkbox]), select { display: block; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; margin-top: 6px; font: inherit; }
textarea { resize: vertical; line-height: 1.7; } button { padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-surface); cursor: pointer; font: inherit; } button:disabled { opacity: .5; cursor: default; }
.primary { background: var(--primary); color: var(--text-on-primary); margin-top: 12px; width: 100%; }
.material-actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; } .material-actions button { flex: 1; white-space: nowrap; }
.check { display: flex; align-items: flex-start; gap: 8px; } details { margin-top: 16px; } summary { cursor: pointer; color: var(--text-2); }
.material-item { display: block; text-align: left; width: 100%; margin: 10px 0; } .material-item span { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; margin: 6px 0; line-height: 1.6; }
.material-text { white-space: pre-wrap; max-height: 200px; overflow: auto; } .error { color: var(--danger); } .missing { padding: 10px; border: 2px solid var(--warning); border-radius: 6px; }
@media (max-width: 850px) { .field-editor { flex: 0 0 auto; width: 100%; max-height: 45dvh; border-left: 0; border-top: 1px solid var(--border); } }
</style>
