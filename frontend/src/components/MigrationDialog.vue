<script setup lang="ts">
/**
 * 迁移弹层（M10，PRD 4.7 / D7）：两段式。
 * prompt——切到 ready 新模板且可迁移时询问「迁移 / 跳过」；
 * plan——三清单确认：①自动匹配（只读）②同类型多候选点选（按序预选）
 * ③无匹配手动指定或留空。②③选项跨行互斥占用（同一目标区域只认一处）。
 * 确认时把三清单最终结果整包 emit 给 store 落库。
 */
import { useModalEsc } from '../composables/useModalEsc'
import { computed, ref, watch } from 'vue'
import type {
  MigrationAutoItem,
  MigrationOption,
  MigrationPlan,
} from '../api/migrations'

const props = defineProps<{
  stage: 'prompt' | 'plan'
  sourceTemplateName: string
  sourceVersionName: string
  sourceBindingCount: number
  targetTemplateName: string
  plan: MigrationPlan | null
  error: string | null
  submitting: boolean
}>()

const emit = defineEmits<{
  proceed: []
  skip: []
  apply: [bindings: { region_id: number; block_id: number }[]]
  close: []
}>()

/** ②③行选择状态：source_region_id → 目标 region_id（null = 留空）。 */
const candidatePicks = ref<Record<number, number | null>>({})
const unmatchedPicks = ref<Record<number, number | null>>({})

// plan 就绪时初始化默认选择：①不占②③池；②按文档流顺序首个可用者预选
watch(
  () => props.plan,
  p => {
    if (!p) {
      candidatePicks.value = {}
      unmatchedPicks.value = {}
      return
    }
    const taken = new Set<number>()
    const cp: Record<number, number | null> = {}
    for (const row of p.candidates) {
      const free = row.options.find(o => !taken.has(o.region_id)) ?? null
      cp[row.source_region_id] = free?.region_id ?? null
      if (free) {
        taken.add(free.region_id)
      }
    }
    const up: Record<number, number | null> = {}
    for (const row of p.unmatched) {
      up[row.source_region_id] = null
    }
    candidatePicks.value = cp
    unmatchedPicks.value = up
  },
  { immediate: true },
)

/** 行可选目标 = 传入选项 − 其他行已占用（跨②③互斥）。 */
function availableOptions(options: MigrationOption[], rowKey: number): MigrationOption[] {
  const others = new Set<number>()
  for (const [k, v] of Object.entries(candidatePicks.value)) {
    if (Number(k) !== rowKey && v !== null) {
      others.add(v)
    }
  }
  for (const [k, v] of Object.entries(unmatchedPicks.value)) {
    if (Number(k) !== rowKey && v !== null) {
      others.add(v)
    }
  }
  return options.filter(o => !others.has(o.region_id))
}

const autoCount = computed(() => props.plan?.auto.length ?? 0)
const candidateCount = computed(() => props.plan?.candidates.length ?? 0)
const unmatchedCount = computed(() => props.plan?.unmatched.length ?? 0)
/** 将落库的绑定总数 = ①全部 + ②③已点选数。 */
const applyCount = computed(() => {
  if (!props.plan) {
    return 0
  }
  const picked = (m: Record<number, number | null>) =>
    Object.values(m).filter(v => v !== null).length
  return autoCount.value + picked(candidatePicks.value) + picked(unmatchedPicks.value)
})

function bindingSettings(row: { line_break_mode?: 'paragraph' | 'soft'; position?: 'inside' | 'before' | 'after' }) {
  return { ...(row.line_break_mode === 'soft' ? { line_break_mode: row.line_break_mode } : {}),
    ...(row.position && row.position !== 'inside' ? { position: row.position } : {}) }
}
function onApply(): void {
  const plan = props.plan
  if (!plan) {
    return
  }
  const bindings = [
    ...plan.auto.map(
      (a: MigrationAutoItem) => ({ region_id: a.target_region_id, block_id: a.block_id, ...bindingSettings(a) }),
    ),
    ...plan.candidates
      .filter(c => candidatePicks.value[c.source_region_id] !== null)
      .map(c => ({
        region_id: candidatePicks.value[c.source_region_id]!,
        block_id: c.block_id,
        ...bindingSettings(c),
      })),
    ...plan.unmatched
      .filter(u => unmatchedPicks.value[u.source_region_id] !== null)
      .map(u => ({
        region_id: unmatchedPicks.value[u.source_region_id]!,
        block_id: u.block_id,
        ...bindingSettings(u),
      })),
  ]
  emit('apply', bindings)
}
useModalEsc(() => emit('close'))
</script>

<template>
  <!-- 遮罩：点击关闭 = 跳过；卡片阻止冒泡（复用 VersionDialog 布局） -->
  <dialog
    ref="modal"
    class="dialog-mask"
    aria-label="换模板迁移"
    aria-modal="true"
    tabindex="-1"
    data-testid="migration-dialog"
    @click.self="emit('close')"
  >
    <div class="dialog-card">
      <div class="dialog-head">
        <span class="title">换模板迁移</span>
        <button
          type="button"
          class="icon-btn"
          aria-label="关闭"
          @click="emit('close')"
        >
          ×
        </button>
      </div>

      <!-- 段一：迁移询问 -->
      <div
        v-if="stage === 'prompt'"
        class="prompt-body"
      >
        <p class="prompt-text">
          检测到模板「{{ sourceTemplateName }}」的版本「{{ sourceVersionName }}」有
          <b>{{ sourceBindingCount }}</b> 个绑定，可按区域类型自动迁移到当前模板
          「{{ targetTemplateName }}」。
        </p>
        <p
          v-if="error"
          class="error"
          data-testid="migration-error"
        >
          {{ error }}
        </p>
        <div class="dialog-foot">
          <button
            type="button"
            class="ghost"
            data-testid="migration-skip"
            @click="emit('skip')"
          >
            跳过，从空白开始
          </button>
          <button
            type="button"
            class="primary"
            :disabled="submitting"
            data-testid="migration-proceed"
            @click="emit('proceed')"
          >
            {{ submitting ? '计算方案中…' : '迁移绑定' }}
          </button>
        </div>
      </div>

      <!-- 段二：三清单确认 -->
      <div
        v-else
        class="plan-body"
      >
        <p class="plan-summary">
          从「{{ sourceTemplateName }}·{{ plan?.source_version_name }}」迁移到
          「{{ targetTemplateName }}」：
        </p>

        <section
          v-if="autoCount > 0"
          data-testid="migration-auto-list"
        >
          <h4>自动匹配（{{ autoCount }}）</h4>
          <ul class="rows">
            <li
              v-for="a in plan?.auto"
              :key="a.source_region_id"
              class="row auto"
            >
              <span class="label">{{ a.source_label }} → {{ a.target_label }}</span>
              <span class="block-name">{{ a.block_name }}</span>
            </li>
          </ul>
        </section>

        <section
          v-if="candidateCount > 0"
          data-testid="migration-candidates"
        >
          <h4>同类型多候选，请点选（{{ candidateCount }}）</h4>
          <ul class="rows">
            <li
              v-for="c in plan?.candidates"
              :key="c.source_region_id"
              class="row"
            >
              <span class="label">{{ c.source_label }}</span>
              <span class="block-name">{{ c.block_name }}</span>
              <select
                v-model="candidatePicks[c.source_region_id]"
                class="pick"
                :data-testid="`migration-pick-${c.source_region_id}`"
              >
                <option :value="null">
                  留空
                </option>
                <option
                  v-for="o in availableOptions(c.options, c.source_region_id)"
                  :key="o.region_id"
                  :value="o.region_id"
                >
                  {{ o.label }}
                </option>
              </select>
            </li>
          </ul>
        </section>

        <section
          v-if="unmatchedCount > 0"
          data-testid="migration-unmatched"
        >
          <h4>无同类型区域，请手动指定或留空（{{ unmatchedCount }}）</h4>
          <ul class="rows">
            <li
              v-for="u in plan?.unmatched"
              :key="u.source_region_id"
              class="row"
            >
              <span class="label">{{ u.source_label }}</span>
              <span class="block-name">{{ u.block_name }}</span>
              <select
                v-model="unmatchedPicks[u.source_region_id]"
                class="pick"
                :data-testid="`migration-pick-${u.source_region_id}`"
              >
                <option :value="null">
                  留空
                </option>
                <option
                  v-for="o in availableOptions(u.manual_options, u.source_region_id)"
                  :key="o.region_id"
                  :value="o.region_id"
                >
                  {{ o.label }}
                </option>
              </select>
            </li>
          </ul>
        </section>

        <p
          v-if="autoCount === 0 && candidateCount === 0 && unmatchedCount === 0"
          class="empty"
        >
          源版本没有可迁移的绑定。
        </p>

        <p
          v-if="error"
          class="error"
          data-testid="migration-error"
        >
          {{ error }}
        </p>
        <div class="dialog-foot">
          <span
            class="count"
            data-testid="migration-count"
          >将迁移 {{ applyCount }} 个绑定</span>
          <button
            type="button"
            class="ghost"
            data-testid="migration-cancel"
            @click="emit('close')"
          >
            取消
          </button>
          <button
            type="button"
            class="primary"
            :disabled="submitting"
            data-testid="migration-apply"
            @click="onApply"
          >
            {{ submitting ? '迁移中…' : '确认迁移' }}
          </button>
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.dialog-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--modal-backdrop);
}

.dialog-card {
  width: min(560px, 92%);
  max-height: 86%;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-radius: 8px;
  box-shadow: 0 4px 20px var(--shadow-modal);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.icon-btn {
  border: none;
  background: none;
  font-size: 18px;
  color: var(--text-3);
  cursor: pointer;
  line-height: 1;
}

.prompt-body {
  padding: 14px;
}

.prompt-text {
  margin: 0 0 4px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
}

.plan-body {
  padding: 12px 14px;
  overflow: auto;
}

.plan-summary {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-2);
}

h4 {
  margin: 10px 0 6px;
  font-size: 12px;
  color: var(--text-1);
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-migration);
}

.row.auto {
  background: var(--success-bg-hover);
}

.label {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
}

.block-name {
  flex-shrink: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--primary);
}

.pick {
  flex-shrink: 0;
  max-width: 180px;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--text-1);
}

.empty {
  margin: 8px 0;
  font-size: 12px;
  color: var(--text-3);
}

.error {
  margin: 8px 0 0;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-bg-subtle);
  border-radius: 4px;
}

.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 0;
}

.prompt-body .dialog-foot {
  padding-top: 12px;
}

.count {
  margin-right: auto;
  font-size: 12px;
  color: var(--text-2);
}

.ghost {
  padding: 5px 14px;
  font-size: 13px;
  color: var(--text-2);
  background: none;
  border: 1px solid var(--border-control);
  border-radius: 4px;
  cursor: pointer;
}

.primary {
  padding: 5px 14px;
  font-size: 13px;
  color: var(--text-on-primary);
  background: var(--primary);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
