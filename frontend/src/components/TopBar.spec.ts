import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/app'
import { usePreviewStore } from '../stores/preview'
import { useHistoryStore } from '../stores/history'
import TopBar from './TopBar.vue'

const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.unstubAllGlobals()
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
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
function mountTopBar(attach = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(TopBar, { global: { plugins: [pinia] }, attachTo: attach ? document.body : undefined })
  wrappers.push(wrapper)
  return wrapper
}

describe('TopBar 紧凑导航', () => {
  it('四个主入口明确当前页面，帮助和其他操作保持折叠', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const tabs = wrapper.findAll('.tab')
    expect(tabs).toHaveLength(4)
    expect(tabs[0].text()).toBe('文稿')
    expect(tabs.map(tab => tab.text())).toEqual(['文稿', '模板', '素材', '归档库'])
    expect(tabs[0].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
    expect(tabs[0].attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('button').map(button => button.text())).toEqual(['文稿', '模板', '素材', '归档库', '更多 ⌄'])
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=import-template]').exists()).toBe(false)
  })

  it('模板制作指南收进更多，操作后收起并可回到文稿列表', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const appStore = useAppStore()
    expect(appStore.activeTab).toBe('documents')

    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    await wrapper.findAll('[role=menuitem]').find(button => button.text() === '模板制作指南')!.trigger('click')
    expect(appStore.activeTab).toBe('guide')
    expect(wrapper.find('[role=menu]').exists()).toBe(false)

    await wrapper.findAll('.tab')[0].trigger('click')
    expect(appStore.activeTab).toBe('documents')
  })

  it('展开后导入模板可用，点击选择文件后收起菜单', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    const buttons = wrapper.findAll('[data-testid="import-template"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text()).toBe('导入模板')
    expect(buttons[0].attributes('disabled')).toBeUndefined()
    await buttons[0].trigger('click')
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
  })

  it('健康绿点已迁至 StatusBar，TopBar 不再渲染（2026-09-18 UI 调整③）', () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    expect(wrapper.find('.health-dot').exists()).toBe(false)
  })

  it('归档库进入独立页面，保留按归档编号定位的公开接口', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    expect(wrapper.find('[role=dialog]').exists()).toBe(false)
    await wrapper.findAll('.tab')[3].trigger('click')
    expect(useAppStore().activeTab).toBe('archives')
    expect(useAppStore().archiveId).toBeNull()
    expect(wrapper.find('[role=dialog]').exists()).toBe(false)
    wrapper.vm.openArchives(7)
    await flushPromises()
    expect(useAppStore().archiveId).toBe(7)
    expect(useAppStore().activeTab).toBe('archives')
  })

  it('更多菜单响应 Esc 和外部点击，键盘可移动到下一项', async () => {
    stubHealth(true)
    const wrapper = mountTopBar(true)
    const trigger = wrapper.get('[aria-haspopup=menu]')
    await trigger.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[role=menuitem]').element)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(document.activeElement?.textContent?.trim()).toBe('模板制作指南')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    await trigger.trigger('click')
    document.body.click()
    await flushPromises()
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
  })

  it('键盘激活菜单动作后归还触发按钮，外部点击不抢焦点', async () => {
    stubHealth(true)
    const wrapper = mountTopBar(true)
    const trigger = wrapper.get('[aria-haspopup=menu]')
    await trigger.trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    const guide = wrapper.findAll('[role=menuitem]').find(button => button.text() === '模板制作指南')!
    expect(document.activeElement).toBe(guide.element)
    // jsdom 不合成 Enter 的默认 click，显式触发聚焦菜单项的激活行为。
    await guide.trigger('click')
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    await trigger.trigger('click')
    const workbench = wrapper.findAll('.tab')[0]
    ;(workbench.element as HTMLButtonElement).focus()
    await workbench.trigger('click')
    expect(document.activeElement).toBe(workbench.element)
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
  })

  it.each([false, true])('Tab 关闭菜单时从触发按钮继续原生移动（Shift=%s）', async shiftKey => {
    stubHealth(true)
    const wrapper = mountTopBar(true)
    const trigger = wrapper.get('[aria-haspopup=menu]')
    await trigger.trigger('click')
    expect(document.activeElement).toBe(wrapper.get('[role=menuitem]').element)
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true, bubbles: true })
    document.activeElement?.dispatchEvent(event)
    await flushPromises()
    // jsdom 不执行原生 Tab 移动；确认起点已恢复且默认移动未被拦截。
    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('程序打开归档库时不将焦点抢回更多按钮', async () => {
    stubHealth(true)
    const wrapper = mountTopBar(true)
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    const workbench = wrapper.findAll('.tab')[0]
    ;(workbench.element as HTMLButtonElement).focus()
    wrapper.vm.openArchives(7)
    await flushPromises()
    expect(document.activeElement).toBe(workbench.element)
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
  })

  it('撤销重做只在菜单中出现，并保留操作和忙碌禁用条件', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const history = useHistoryStore()
    history.enabled = true; history.undoCount = 1; history.redoCount = 1
    const move = vi.spyOn(history, 'move').mockResolvedValue()
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    const undo = wrapper.findAll('[role=menuitem]').find(button => button.text().startsWith('撤销'))!
    expect(undo.attributes('disabled')).toBeUndefined()
    await undo.trigger('click')
    expect(move).toHaveBeenCalledWith(false, expect.any(Function))
    expect(wrapper.find('[role=menu]').exists()).toBe(false)
    usePreviewStore().refreshing = true
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    const historyButtons = wrapper.findAll('[role=menuitem]').filter(button => /^(撤销|重做)/.test(button.text()))
    expect(historyButtons).toHaveLength(2)
    expect(historyButtons.every(button => button.attributes('disabled') !== undefined)).toBe(true)
    expect(wrapper.findAll('.tab')[3].attributes('disabled')).toBeDefined()
  })

  it('浏览模板、素材和归档不改变当前模板或文稿，不请求切换预览', async () => {
    stubHealth(true)
    const wrapper = mountTopBar()
    const preview = usePreviewStore()
    preview.currentTemplateId = 9; preview.currentVersionId = 23
    const select = vi.spyOn(preview, 'selectTemplate')
    for (const [index, page] of [[1, 'templates'], [2, 'materials'], [3, 'archives']] as const) {
      await wrapper.findAll('.tab')[index]!.trigger('click')
      expect(useAppStore().activeTab).toBe(page)
      expect(wrapper.findAll('.tab')[index]!.attributes('aria-current')).toBe('page')
      expect(preview.currentTemplateId).toBe(9)
      expect(preview.currentVersionId).toBe(23)
    }
    expect(select).not.toHaveBeenCalled()
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
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    await wrapper.get('[data-testid="import-template"]').trigger('click')
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
    await wrapper.get('[aria-haspopup=menu]').trigger('click')
    expect(wrapper.get('[data-testid="import-template"]').text()).toBe('导入模板') // uploading 复位
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


it('导入进度区分请求和渲染，超五秒提示，结束后消失', async () => {
  vi.useFakeTimers()
  const w = mountTopBar()
  const store = usePreviewStore()
  store.uploadStartedAt = Date.now()
  store.uploadPhase = 'request'
  await flushPromises()
  expect(w.get('[data-testid=upload-progress]').text()).toContain('上传并解析')
  await vi.advanceTimersByTimeAsync(6000)
  expect(w.get('[data-testid=upload-progress]').text()).toContain('已等待 6 秒')
  store.uploadPhase = 'render'
  await flushPromises()
  expect(w.get('[data-testid=upload-progress]').text()).toContain('解析完成')
  store.uploadPhase = 'idle'
  store.uploadStartedAt = null
  await flushPromises()
  expect(w.find('[data-testid=upload-progress]').exists()).toBe(false)
  vi.useRealTimers()
})
