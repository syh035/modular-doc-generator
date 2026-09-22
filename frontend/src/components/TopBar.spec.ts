import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'
import TopBar from './TopBar.vue'

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** stub /api/health（TopBar 挂载即探测）。 */
function stubHealth(ok: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      if (ok) {
        return Promise.resolve(
          Response.json({
            status: 'ok',
            libreoffice: { available: true, path: null, version: null, hint: null },
          }),
        )
      }
      return Promise.reject(new Error('连接失败'))
    }),
  )
}

/** 挂载 TopBar 并保证测试与组件共用同一 pinia 实例。 */
function mountTopBar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(TopBar, { global: { plugins: [pinia] } })
}

describe('TopBar tab 导航（UI 调整①）', () => {
  it('渲染两个 tab，默认工作台激活', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const tabs = wrapper.findAll('.tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0].text()).toBe('工作台')
    expect(tabs[1].text()).toBe('模板制作指南')
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
  })

  it('点击 tab 切换 appStore.activeTab', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const appStore = useAppStore()
    expect(appStore.activeTab).toBe('workbench')

    await wrapper.findAll('.tab')[1].trigger('click')
    expect(appStore.activeTab).toBe('guide')
    expect(wrapper.findAll('.tab')[1].classes()).toContain('active')

    await wrapper.findAll('.tab')[0].trigger('click')
    expect(appStore.activeTab).toBe('workbench')
  })

  it('导入模板按钮可用，导出占位按钮已删（导出在预览工具条，M9 验收开放项）', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const buttons = wrapper.findAll('.actions button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text()).toBe('导入模板')
    expect(buttons[0].attributes('disabled')).toBeUndefined()
  })

  it('健康绿点已迁至 StatusBar，TopBar 不再渲染（2026-09-18 UI 调整③）', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    expect(wrapper.find('.health-dot').exists()).toBe(false)
  })
})

describe('导入模板上传（占位按钮转正）', () => {
  it('点击按钮触发隐藏 file input 的选择框', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const input = wrapper.find('input[type="file"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('accept')).toBe('.docx')
    const clickSpy = vi.spyOn(input.element as HTMLInputElement, 'click').mockImplementation(() => {})
    await wrapper.find('.actions button').trigger('click')
    expect(clickSpy).toHaveBeenCalledOnce()
  })

  it('选择文件 → POST 上传 → 刷新列表并自动选中新模板', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url === '/api/templates') {
        return Promise.resolve(
          Response.json(
            {
              id: 7,
              filename: 'new.docx',
              storage_name: '7_new.docx',
              sha256: 'abc',
              status: 'pending_review',
              created_at: '',
              updated_at: '',
              regions: [],
              default_version_id: 9,
              reused: false,
            },
            { status: 201 },
          ),
        )
      }
      if (url === '/api/templates') {
        return Promise.resolve(
          Response.json({ templates: [{ id: 7, filename: 'new.docx', regions_count: 0 }] }),
        )
      }
      if (url === '/api/templates/7') {
        return Promise.resolve(
          Response.json({ id: 7, filename: 'new.docx', default_version_id: 9, regions: [] }),
        )
      }
      if (url === '/api/templates/7/versions') {
        return Promise.resolve(
          Response.json({
            versions: [
              {
                id: 9,
                template_id: 7,
                name: '默认版本',
                binding_count: 0,
                created_at: '',
                updated_at: '',
              },
            ],
          }),
        )
      }
      if (url === '/api/versions/9/preview') {
        return Promise.resolve(new Response(new ArrayBuffer(3), { status: 200 }))
      }
      if (url === '/api/versions/9/overlay') {
        return Promise.resolve(Response.json({ version_id: 9, regions: [] }))
      }
      if (url.startsWith('/api/health')) {
        return Promise.resolve(
          Response.json({
            status: 'ok',
            libreoffice: { available: true, path: null, version: null, hint: null },
          }),
        )
      }
      return Promise.resolve(
        Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mountTopBar()
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['docx-bytes'], 'new.docx')],
    })
    await input.trigger('change')
    await flushPromises()

    // POST 为 multipart FormData
    const post = fetchMock.mock.calls.find(
      c => String(c[0]) === '/api/templates' && c[1]?.method === 'POST',
    )
    expect(post?.[1]?.body).toBeInstanceOf(FormData)
    // 列表刷新 + 新模板选中且版本渲染就绪
    const store = usePreviewStore()
    expect(store.templates.map(t => t.id)).toEqual([7])
    expect(store.currentTemplateId).toBe(7)
    expect(store.status).toBe('ready')
    expect(wrapper.find('.actions button').text()).toBe('导入模板') // uploading 复位
  })

  it('上传失败 → alert 可读错误，不改当前选择', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if ((init?.method ?? 'GET') === 'POST' && url === '/api/templates') {
          return Promise.resolve(
            Response.json(
              { error: { code: 'TEMPLATE_CORRUPT', message: '文件已损坏或不是有效的 DOCX' } },
              { status: 400 },
            ),
          )
        }
        if (url.startsWith('/api/health')) {
          return Promise.resolve(
            Response.json({
              status: 'ok',
              libreoffice: { available: true, path: null, version: null, hint: null },
            }),
          )
        }
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }),
    )

    const wrapper = mountTopBar()
    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File(['junk'], 'bad.docx')],
    })
    await input.trigger('change')
    await flushPromises()

    expect(alertSpy).toHaveBeenCalledWith('文件已损坏或不是有效的 DOCX')
    const store = usePreviewStore()
    expect(store.currentTemplateId).toBeNull()
    expect(store.status).toBe('idle')
  })
})
