/**
 * 全局应用状态：服务健康、当前模板/版本（M0 占位）。
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

export const useAppStore = defineStore('app', () => {
  /** 后端健康状态；null = 尚未探测 */
  const health = ref<HealthStatus | null>(null)
  /** 健康探测错误信息（网络不通等） */
  const healthError = ref<string | null>(null)

  async function refreshHealth(): Promise<void> {
    try {
      health.value = await apiFetch<HealthStatus>('/api/health')
      healthError.value = null
    } catch (err) {
      health.value = null
      healthError.value = err instanceof Error ? err.message : String(err)
    }
  }

  return { health, healthError, refreshHealth }
})
