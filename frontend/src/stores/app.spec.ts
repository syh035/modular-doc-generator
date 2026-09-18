import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type HealthStatus } from '../stores/app'

const healthy: HealthStatus = {
  status: 'ok',
  libreoffice: { available: true, path: '/usr/local/bin/soffice', version: '24.8', hint: null },
}

describe('app store（冒烟）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('refreshHealth 成功时写入 health 且清空错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => healthy }),
    )
    const store = useAppStore()
    await store.refreshHealth()
    expect(store.health).toEqual(healthy)
    expect(store.healthError).toBeNull()
    vi.unstubAllGlobals()
  })

  it('refreshHealth 网络失败时写入错误信息（统一网络错误文案）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const store = useAppStore()
    await store.refreshHealth()
    expect(store.health).toBeNull()
    expect(store.healthError).toBe('无法连接本地服务，请确认后端已启动')
    vi.unstubAllGlobals()
  })

  it('tab 切换：默认工作台，setTab 切到指南再切回（UI 调整①）', () => {
    const store = useAppStore()
    expect(store.activeTab).toBe('workbench')
    store.setTab('guide')
    expect(store.activeTab).toBe('guide')
    store.setTab('workbench')
    expect(store.activeTab).toBe('workbench')
  })
})
