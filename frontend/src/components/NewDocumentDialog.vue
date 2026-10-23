<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ApiRequestError } from '../api/client'
import { createMigratedDocument, planNewDocument, previewNewDocument,
  type CreatedDocument, type DocumentDecisions, type DocumentPlan, type DocumentTrial } from '../api/migrations'
import type { TemplateListItem } from '../api/templates'
import { useModalEsc } from '../composables/useModalEsc'
import MigrationPreview from './MigrationPreview.vue'

const props = defineProps<{
  source: { id: number; template_id: number; name: string }
  templates: TemplateListItem[]
  openDocument: (document: CreatedDocument) => Promise<void>
}>()
const emit = defineEmits<{ close: [created: CreatedDocument | null] }>()
const target = ref('')
const name = ref(`${props.source.name} · 新模板`.slice(0, 30))
const nameInput = ref<HTMLInputElement | null>(null)
const sourceList = ref<HTMLElement | null>(null)
const plan = ref<DocumentPlan | null>(null)
// 不存在=尚未安排，null=明确不带入；两者不能混用。
const decisions = ref<Record<number, number | null>>({})
const selected = ref<number | null>(null)
const trial = ref<DocumentTrial | null>(null)
const canvasReady = ref(false)
const previewZoom = ref('fit')
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const targetLabels = ref<Record<number, string>>({})
let restoreChoiceFocus = false
const stale = ref(false)
const created = ref<CreatedDocument | null>(null)
let request = 0
let disposed = false
let attempt: { target: number; body: DocumentDecisions; name: string; key: string } | null = null
const uncertain = ref(false)
const choices = computed(() => props.templates.filter(template => template.id !== props.source.template_id))
const active = computed(() => plan.value?.source_items.find(item => item.source_region_id === selected.value))
const remaining = computed(() => plan.value?.source_items.filter(item => decisions.value[item.source_region_id] === undefined).length ?? 0)
const occupied = computed(() => Object.fromEntries((plan.value?.source_items ?? []).flatMap(item => {
  const position = decisions.value[item.source_region_id]
  return typeof position === 'number' ? [[position, item.source_label]] : []
})))
const locked = computed(() => submitting.value || created.value !== null || uncertain.value)
const canCreate = computed(() => plan.value && trial.value && canvasReady.value && !loading.value && !stale.value
  && remaining.value === 0 && name.value.trim().length > 0 && !locked.value)
function message(err: unknown): string { return err instanceof Error ? err.message : String(err) }
function body(): DocumentDecisions {
  return {
    source_version_id: props.source.id, plan_token: plan.value!.plan_token,
    placements: Object.entries(decisions.value).flatMap(([source, position]) => typeof position === 'number'
      ? [{ source_region_id: Number(source), target_region_id: position }] : []),
    omitted_source_region_ids: Object.entries(decisions.value).filter(([, position]) => position === null).map(([source]) => Number(source)),
  }
}
async function render(seq: number): Promise<void> {
  const result = await previewNewDocument(Number(target.value), body())
  if (disposed || seq !== request) return
  targetLabels.value = Object.fromEntries(result.items.map(item => [item.id, item.label]))
  trial.value = result
}
function failure(err: unknown): void {
  error.value = message(err)
  if (err instanceof ApiRequestError && err.code === 'MIGRATION_PLAN_STALE') stale.value = true
}
async function loadPlan(): Promise<void> {
  const seq = ++request
  plan.value = null; trial.value = null; decisions.value = {}; canvasReady.value = false
  error.value = ''; notice.value = ''; stale.value = false
  targetLabels.value = {}; restoreChoiceFocus = false
  if (!target.value) { loading.value = false; return }
  loading.value = true
  try {
    const result = await planNewDocument(Number(target.value), props.source.id)
    if (disposed || seq !== request) return
    plan.value = result
    const positions: Record<number, number | null> = {}
    const taken = new Set<number>()
    for (const row of result.auto) { positions[row.source_region_id] = row.target_region_id; taken.add(row.target_region_id) }
    for (const row of result.candidates) {
      const available = row.options.find(option => !taken.has(option.region_id))
      if (available) { positions[row.source_region_id] = available.region_id; taken.add(available.region_id) }
    }
    decisions.value = positions
    selected.value = result.source_items.find(item => positions[item.source_region_id] === undefined)?.source_region_id
      ?? result.source_items[0]?.source_region_id ?? null
    await nextTick()
    if (disposed || seq !== request) return
    const selectedButton = sourceList.value?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (selectedButton && sourceList.value) sourceList.value.scrollTop = Math.max(0, selectedButton.offsetTop - 12)
    await render(seq)
  } catch (err) { if (!disposed && seq === request) failure(err) }
  finally { if (!disposed && seq === request) loading.value = false }
}
async function refreshTrial(): Promise<void> {
  if (!plan.value || locked.value) return
  const seq = ++request
  restoreChoiceFocus = true
  loading.value = true; trial.value = null; canvasReady.value = false; error.value = ''
  try { await render(seq) }
  catch (err) { if (!disposed && seq === request) failure(err) }
  finally { if (!disposed && seq === request) loading.value = false }
}
function status(source: number): string {
  const position = decisions.value[source]
  if (position === undefined) return '尚未安排'
  if (position === null) return '本次不带入'
  return `放在「${targetLabels.value[position] ?? '所选位置'}」`
}
async function canvasState(value: boolean): Promise<void> {
  canvasReady.value = value
  if (!value || !restoreChoiceFocus) return
  restoreChoiceFocus = false
  await nextTick()
  if (document.activeElement?.matches('[data-modal-autofocus]')) {
    document.getElementById(`migration-source-${selected.value}`)?.focus({ preventScroll: true })
  }
}
async function place(id: number): Promise<void> {
  if (!active.value || loading.value || locked.value || stale.value || !canvasReady.value) return
  const owner = Object.entries(decisions.value).find(([source, position]) => position === id && Number(source) !== selected.value)
  if (owner) { notice.value = '此位置已有文字，请先选择那段文字重新安排，或选择本次不带入。'; return }
  decisions.value = { ...decisions.value, [active.value.source_region_id]: id }
  notice.value = `已将「${active.value.source_label}」放在所选位置`
  await refreshTrial()
}
async function omit(): Promise<void> {
  if (!active.value || loading.value || locked.value || stale.value) return
  decisions.value = { ...decisions.value, [active.value.source_region_id]: null }
  notice.value = '这段文字本次不带入，原稿中的文字保留。'
  await refreshTrial()
}
async function submit(): Promise<void> {
  if (submitting.value || (!created.value && !uncertain.value && !canCreate.value)) return
  submitting.value = true; error.value = ''
  let focusName = false
  try {
    if (!created.value) {
      attempt ??= { target: Number(target.value), body: body(), name: name.value.trim(), key: crypto.randomUUID() }
      try {
        created.value = await createMigratedDocument(attempt.target, attempt.body, attempt.name, attempt.key)
        uncertain.value = false
      } catch (err) {
        // 网络中断或服务错误可能发生在提交之后；重试必须复用原请求与键。
        uncertain.value = !(err instanceof ApiRequestError) || ![
          'VERSION_NAME_TAKEN', 'MIGRATION_INVALID', 'MIGRATION_PLAN_STALE', 'MIGRATION_REQUEST_CONFLICT',
          'TEMPLATE_NOT_FOUND', 'VERSION_NOT_FOUND', 'MIGRATION_SAME_TEMPLATE',
        ].includes(err.code)
        if (!uncertain.value) attempt = null
        if (err instanceof ApiRequestError && err.code === 'VERSION_NAME_TAKEN') {
          error.value = '此模板下已有同名文稿，请换一个名称'; focusName = true
        } else failure(err)
        return
      }
    }
    try {
      await props.openDocument(created.value)
      if (!disposed) emit('close', created.value)
    } catch (err) { if (!disposed) error.value = `新稿已生成，打开预览失败：${message(err)}。可重试打开，无需重新生成。` }
  } finally {
    if (!disposed) {
      submitting.value = false
      if (focusName) { await nextTick(); nameInput.value?.focus({ preventScroll: true }) }
    }
  }
}
function close(): void { if (!submitting.value) emit('close', created.value) }
useModalEsc(close)
onBeforeUnmount(() => { disposed = true; request++ })
</script>

<template>
  <dialog
    ref="modal"
    class="migration-dialog"
    aria-label="更换模板生成新稿"
    tabindex="-1"
    @click.self="close"
  >
    <div class="card">
      <header>
        <div><h2>更换模板</h2><p>将「{{ source.name }}」的填写文字放入新模板，生成另一份文稿。原稿保留。</p></div><button
          :disabled="submitting"
          aria-label="关闭更换模板"
          @click="close"
        >
          ×
        </button>
      </header>
      <div class="settings">
        <label>选择新模板<select
          v-model="target"
          :disabled="locked"
          data-modal-autofocus
          @change="loadPlan"
        ><option value="">请选择模板</option><option
          v-for="template in choices"
          :key="template.id"
          :value="String(template.id)"
        >{{ template.filename }}</option></select></label>
        <label>新文稿名称<input
          ref="nameInput"
          v-model="name"
          maxlength="30"
          :disabled="locked"
          aria-label="新文稿名称"
        ></label>
      </div>
      <p
        v-if="!choices.length"
        class="feedback"
      >
        请先到模板页导入另一个模板，再从原稿更换。
      </p>
      <div
        v-if="target"
        class="workspace"
      >
        <aside
          ref="sourceList"
          aria-label="原稿填写文字"
        >
          <h3>带入的文字 <span v-if="plan">{{ plan.source_items.length }} 段</span></h3>
          <p class="hint">
            先选一段文字，再点右侧框中的位置。已放置的文字也可重新安排。
          </p>
          <p
            v-if="plan && !plan.source_items.length"
            class="hint"
          >
            原稿没有可带入的填写文字，将生成空白新稿。
          </p>
          <button
            v-for="item in plan?.source_items"
            :id="`migration-source-${item.source_region_id}`"
            :key="item.source_region_id"
            class="source"
            :class="{ selected: selected === item.source_region_id }"
            :disabled="locked"
            :aria-pressed="selected === item.source_region_id"
            @click="selected = item.source_region_id; notice = ''"
          >
            <strong>{{ item.source_label }}</strong><span class="content">{{ item.kind === 'blank' ? '空行' : item.content }}</span><small>{{ status(item.source_region_id) }}</small>
          </button>
          <div
            v-if="active"
            class="current-choice"
          >
            <span>当前选择：{{ active.source_label }}</span><button
              :disabled="loading || locked || stale"
              @click="omit"
            >
              本次不带入
            </button>
          </div>
          <p
            v-if="plan"
            class="hint"
          >
            {{ remaining ? `还有 ${remaining} 段文字需要安排` : '每段文字均已安排，可查看效果并生成' }}
          </p>
        </aside>
        <div class="preview-area">
          <p
            v-if="loading"
            class="feedback"
            role="status"
          >
            正在试排，请稍候…
          </p>
          <MigrationPreview
            v-if="trial"
            v-model:zoom="previewZoom"
            :trial="trial"
            :occupied="occupied"
            :disabled="loading || locked || stale || !active"
            @place="place"
            @ready="canvasState"
            @failed="error = $event; canvasReady = false"
          />
          <p
            v-else-if="!loading && !error"
            class="feedback"
          >
            选择文字后，点击预览中的位置。
          </p>
        </div>
      </div>
      <div
        class="messages"
        aria-live="polite"
      >
        <p
          v-if="notice"
          role="status"
        >
          {{ notice }}
        </p>
        <p
          v-if="error"
          class="error"
          role="alert"
        >
          {{ error }}
        </p>
        <p
          v-if="uncertain"
          class="error"
        >
          生成结果尚未确认。请重试确认，不会重复建稿；关闭后可到文稿列表核对。
        </p>
        <button
          v-if="error && !locked && target"
          :disabled="loading"
          @click="stale || !plan ? loadPlan() : refreshTrial()"
        >
          {{ stale ? '重新读取原稿与模板' : '重试试排' }}
        </button>
      </div>
      <footer>
        <span>{{ created ? '新稿已保存，重试仅打开' : uncertain ? '重试不会重复建稿' : remaining ? `还有 ${remaining} 段文字需要安排` : '确认前不会创建文稿' }}</span><button
          :disabled="submitting"
          @click="close"
        >
          {{ created ? '返回文稿列表' : '取消' }}
        </button><button
          class="primary"
          :disabled="submitting || (!created && !uncertain && !canCreate)"
          @click="submit"
        >
          {{ submitting ? (created ? '正在打开…' : '正在生成…') : created ? '重试打开新稿' : uncertain ? '重试确认生成结果' : '生成新文稿' }}
        </button>
      </footer>
    </div>
  </dialog>
</template>

<style scoped>
.migration-dialog { position: fixed; inset: 0; width: 100%; max-width: none; height: 100%; max-height: none; margin: 0; padding: 16px; border: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop); color: var(--text-1); }
.card { width: min(1120px, 100%); max-height: 94dvh; display: flex; flex-direction: column; overflow: hidden; border-radius: 12px; background: var(--bg-surface); box-shadow: 0 8px 32px var(--shadow-modal); }
header, footer { display: flex; gap: 12px; align-items: center; padding: 14px 18px; flex-shrink: 0; }
header { justify-content: space-between; border-bottom: 1px solid var(--border); }
h2 { margin: 0; font-size: 17px; } header p { margin: 6px 0 0; font-size: 12px; color: var(--text-2); line-height: 1.6; }
button, select, input { font: inherit; } button { cursor: pointer; padding: 7px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--text-1); } button:disabled { opacity: .5; cursor: default; }
.settings { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px 18px; flex-shrink: 0; }
label { min-width: 0; font-size: 12px; display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 8px; } select, input { min-width: 0; width: 100%; box-sizing: border-box; padding: 7px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-1); background: var(--bg-surface); }
.workspace { display: grid; grid-template-columns: 290px minmax(0, 1fr); min-height: 0; height: 62dvh; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
aside { position: relative; min-height: 0; overflow: auto; padding: 14px; border-right: 1px solid var(--border); } h3 { margin: 0 0 8px; font-size: 14px; } h3 span { color: var(--text-3); font-size: 12px; font-weight: 400; }
.hint { font-size: 12px; line-height: 1.6; color: var(--text-2); margin: 8px 0; }
.source { display: block; width: 100%; text-align: left; margin: 8px 0; padding: 10px; background: var(--bg-surface); }
.source.selected { border-color: var(--primary); background: var(--primary-bg-hover); }
.source strong { font-size: 12px; } .content { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin: 6px 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; } .source.selected .content { display: block; max-height: 200px; overflow: auto; }
.source small { color: var(--text-2); } .current-choice { position: sticky; bottom: -14px; background: var(--bg-surface); padding: 10px 0; font-size: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; border-top: 1px solid var(--border); }
.preview-area { min-width: 0; min-height: 0; overflow: hidden; } .feedback { margin: 0; padding: 14px 18px; font-size: 13px; color: var(--text-2); }
.messages { max-height: 120px; overflow: auto; padding: 0 18px; font-size: 12px; } .messages p { margin: 8px 0; line-height: 1.6; } .error { color: var(--danger); }
footer { justify-content: flex-end; flex-wrap: wrap; } footer span { margin-right: auto; color: var(--text-3); font-size: 12px; } .primary { background: var(--primary); color: var(--text-on-primary); border-color: var(--primary); }
@media (max-width: 680px) { .migration-dialog { padding: 8px; } .card { max-height: 97dvh; } header, footer { padding: 10px; } .settings { padding: 10px; grid-template-columns: 1fr; gap: 8px; } .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(110px, 26dvh) minmax(180px, 1fr); height: 61dvh; } aside { border-right: 0; border-bottom: 1px solid var(--border); padding: 10px; } .messages { padding: 0 10px; max-height: 90px; } footer { gap: 6px; } footer span { flex-basis: 100%; } }
</style>
