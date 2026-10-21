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

/** 四入口页面、保留的文稿编辑器与模板制作指南。 */
export type AppTab = 'documents' | 'workbench' | 'templates' | 'materials' | 'archives' | 'guide'

export const useAppStore = defineStore('app', () => {
  /** 后端健康状态；null = 尚未探测 */
  const health = ref<HealthStatus | null>(null)
  /** 健康探测错误信息（网络不通等） */
  const healthError = ref<string | null>(null)
  const activeTab = ref<AppTab>('documents')
  const archiveId = ref<number | null>(null)
  const documentTemplateId = ref<number | null>(null)

  function setTab(tab: AppTab): void {
    if (tab === 'documents') documentTemplateId.value = null
    activeTab.value = tab
  }

  function openArchives(id: number | null = null): void {
    archiveId.value = id
    activeTab.value = 'archives'
  }

  function openTemplateDocuments(templateId: number | null): void {
    documentTemplateId.value = templateId
    activeTab.value = 'documents'
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

  return { health, healthError, activeTab, archiveId, documentTemplateId, setTab, openArchives, openTemplateDocuments, refreshHealth }
})
