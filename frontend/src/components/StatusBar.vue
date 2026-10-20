<script setup lang="ts">
import { formatOverflowGrowth } from '../utils/overflow'
import { computed, defineAsyncComponent, ref } from 'vue'
import type { DisplayRegion } from '../stores/preview'
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'

const appStore = useAppStore()
const previewStore = usePreviewStore()
const DataMaintenance = defineAsyncComponent(() => import('./DataMaintenance.vue'))
const maintenanceOpen = ref(false)
const emit = defineEmits<{ locate: [region: DisplayRegion] }>()
/** 溢出区域清单：大超出在前，同级按溢出比例降序。 */
const overflowRegions = computed(() =>
  previewStore.regions
    .filter(r => r.overflow != null)
    .sort((a, b) => {
      const la = a.overflow!.level === 'large' ? 0 : 1
      const lb = b.overflow!.level === 'large' ? 0 : 1
      if (la !== lb) return la - lb
      return b.overflow!.ratio - a.overflow!.ratio
    }),
)

/** 状态条 chip 视图模型（模板内免非空断言）。 */
const overflowChips = computed(() =>
  overflowRegions.value.map(r => ({
    id: r.id,
    label: r.label,
    level: r.overflow!.level,
    growth: formatOverflowGrowth(r.overflow!.ratio),
    clipped: r.overflow!.clipped,
    page: (r.bbox?.page ?? 0) + 1,
    region: r,
  })),
)

const largeOverflowCount = computed(
  () => overflowChips.value.filter(c => c.level === 'large').length,
)

</script>

<template>
  <!-- 底部状态条：服务状态与溢出提示；区域检查从文档工具进入。 -->
  <footer class="status-bar">
    <button
      type="button"
      class="health"
      aria-label="服务状态与预览维护"
      :class="{ bad: !!appStore.healthError }"
      :title="appStore.healthError ?? (appStore.health?.libreoffice.hint ?? '服务正常')"
      @click="maintenanceOpen = true"
    >
      <i class="dot" />
      <span v-if="appStore.healthError">{{ appStore.healthError }}</span>
      <span v-else-if="appStore.health">服务正常</span>
      <span v-else>正在连接本地服务…</span>
    </button>
    <span
      v-if="appStore.health && !appStore.health.libreoffice.available"
      class="warn"
    >
      LibreOffice 未安装：{{ appStore.health.libreoffice.hint }}
    </span>
    <!-- M13：溢出汇总移入固定高度状态栏，横向滚动，不挤占画布 -->
    <div
      v-if="appStore.activeTab === 'workbench' && overflowChips.length > 0"
      class="overflow-list"
      data-testid="overflow-bar"
    >
      <span class="overflow-title">
        溢出区域 {{ overflowChips.length }} 个（大超出 {{ largeOverflowCount }}）：
      </span>
      <button
        v-for="chip in overflowChips"
        :key="chip.id"
        class="overflow-chip"
        :class="chip.level"
        :title="`点击定位到第 ${chip.page} 页`"
        @click="emit('locate', chip.region)"
      >
        {{ chip.label
        }}<template v-if="chip.clipped">
          （裁剪）
        </template>
        <template v-else>
          {{ chip.growth }}
        </template>
      </button>
    </div>
  </footer>
  <DataMaintenance
    v-if="maintenanceOpen"
    @close="maintenanceOpen = false"
  />
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 36px;
  box-sizing: border-box;
  flex-shrink: 0;
  min-width: 0;
  padding: 4px 16px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-surface);
  border-top: 1px solid var(--border);
}

.health {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(320px, 45%);
}
.health > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health .dot { flex-shrink: 0; }
.warn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 600px) { .status-bar { padding: 4px 12px; gap: 8px; } }

.health .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success); /* 绿 = 服务正常 */
}

.health.bad .dot {
  background: var(--danger);
}

.warn {
  color: var(--warning-notice);
}

/* ---- 溢出状态条（M7）：固定预览区底部 ---- */

.overflow-list {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  align-items: center;
  gap: 6px;
  padding: 0;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-surface);
}

.overflow-title {
  flex-shrink: 0;
  font-weight: 600;
}

.overflow-chip {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-surface);
  border: 1px solid var(--border-control);
  border-radius: 3px;
  cursor: pointer;
}

.overflow-chip.large {
  border-color: var(--danger);
  color: var(--danger);
}

.overflow-chip.small {
  border-color: var(--warning);
  color: var(--warning);
}

.overflow-chip:hover {
  background: var(--bg-muted);
}
</style>
