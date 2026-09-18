/**
 * 全局应用状态：服务健康、顶部 tab、当前模板/版本（M0 占位）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiFetch } from '../api/client'

export interface LibreOfficeStatus {
  available: boolean
  path: string | null
  version: string | null
  hint: string | null
}

export interface HealthStatus {
  status: string
  libreoffice: LibreOfficeStatus
}

/** 顶部 tab：工作台（块库+预览）/ 模板制作指南。 */
export type AppTab = 'workbench' | 'guide'

export const useAppStore = defineStore('app', () => {
  /** 后端健康状态；null = 尚未探测 */
  const health = ref<HealthStatus | null>(null)
  /** 健康探测错误信息（网络不通等） */
  const healthError = ref<string | null>(null)
  /** 顶部 tab（UI 调整①：工作台 / 模板制作指南）。 */
  const activeTab = ref<AppTab>('workbench')

  function setTab(tab: AppTab): void {
    activeTab.value = tab
  }

  async function refreshHealth(): Promise<void> {
    try {
      health.value = await apiFetch<HealthStatus>('/api/health')
      healthError.value = null
    } catch (err) {
      health.value = null
      healthError.value = err instanceof Error ? err.message : String(err)
    }
  }

  return { health, healthError, activeTab, setTab, refreshHealth }
})
