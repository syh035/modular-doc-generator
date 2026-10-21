import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Region } from '../api/templates'
import { registerHistoryHooks } from '../api/historyHooks'
import { usePreviewStore } from './preview'

/** 造一个区域（bbox 可空）。 */
function region(id: number, bbox: Region['bbox']): Region {
  return {
    id,
    template_id: 1,
    type: 'custom',
    label: `字段${id}`,
    placeholder: `{{字段${id}}}`,
    anchor: { kind: 'p', path: [id] },
    order_index: id,
    bbox,
    confidence: null,
    review_status: 'pending',
    created_at: '',
    updated_at: '',
  }
}

/** stub fetch：按 URL 精确路由，可注入延迟。 */
function stubFetch(routes: Record<string, () => unknown>, delays: Record<string, number> = {}) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const handler = routes[url]
    if (handler === undefined) {
      return Promise.resolve(
        Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
      )
    }
    const body = handler()
    return new Promise<Response>(resolve => {
      setTimeout(() => {
        if (body instanceof ArrayBuffer) {
          resolve(new Response(body, { status: 200 }))
        } else {
          resolve(Response.json(body, { status: 200 }))
        }
      }, delays[url] ?? 0)
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.unstubAllGlobals()
})

describe('从文稿列表显式打开', () => {
  function routes() {
    return {
      '/api/templates/2': () => ({ default_version_id: 20 }),
      '/api/templates/2/versions': () => ({ versions: [
        { id: 20, template_id: 2, name: '默认版本', binding_count: 0 },
        { id: 21, template_id: 2, name: '投递稿', binding_count: 1 },
      ] }),
      '/api/versions/21/preview': () => new ArrayBuffer(8),
      '/api/versions/21/overlay': () => ({ regions: [] }),
    }
  }

  it.each([false, true])('直接渲染指定文稿一次，退出检查且不提示迁移（原检查=%s）', async reviewing => {
    const fetcher = stubFetch(routes())
    const store = usePreviewStore()
    store.currentTemplateId = 1; store.currentVersionId = 10; store.status = 'ready'
    store.proofreadMode = reviewing
    store.regions = [{ ...region(1, null), binding: { block_id: 7, block_name: '已填写', status: 'active' } }]
    await store.selectTemplate(2, { versionId: 21 })
    expect(store.status).toBe('ready')
    expect(store.currentVersionId).toBe(21)
    expect(store.proofreadMode).toBe(false)
    expect(store.migrationSource).toBeNull()
    expect(fetcher.mock.calls.map(call => String(call[0])).filter(url => url.endsWith('/preview'))).toEqual(['/api/versions/21/preview'])
  })

  it('列表读取失败或文稿不属于所选模板时停止打开，不渲染其他模板内容', async () => {
    const fetcher = stubFetch(routes())
    const store = usePreviewStore()
    await store.selectTemplate(2, { versionId: 99 })
    expect(store.status).toBe('error')
    expect(store.error).toContain('已不存在或不属于此模板')
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('/preview'))).toBe(false)
    fetcher.mockImplementation(async input => String(input) === '/api/templates/2/versions'
      ? Response.json({ error: { code: 'OFFLINE', message: '列表读取失败' } }, { status: 500 })
      : Response.json({ default_version_id: 20 }))
    await store.selectTemplate(2, { versionId: 21 })
    expect(store.status).toBe('error')
    expect(store.error).toBe('列表读取失败')
  })

  it('显式打开另一模板的空白默认稿也不触发迁移，不写入原稿内容', async () => {
    const fetcher = stubFetch({ ...routes(),
      '/api/versions/20/preview': () => new ArrayBuffer(8),
      '/api/versions/20/overlay': () => ({ regions: [] }),
    })
    const store = usePreviewStore()
    store.currentTemplateId = 1; store.currentVersionId = 10; store.status = 'ready'
    store.templates = [{ id: 2, filename: '目标.docx', status: 'ready', storage_name: '2.docx', sha256: 'test', regions_count: 0, created_at: '', updated_at: '' }]
    store.regions = [{ ...region(1, null), binding: { block_id: 7, block_name: '原稿内容', status: 'active' } }]
    await store.selectTemplate(2, { versionId: 20 })
    expect(store.status).toBe('ready')
    expect(store.currentVersionId).toBe(20)
    expect(store.migrationSource).toBeNull()
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      '/api/templates/2', '/api/templates/2/versions', '/api/versions/20/preview', '/api/versions/20/overlay',
    ])
  })

  it('会话边界清理延迟时，后发打开仍优先，旧请求不再开始取数', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    registerHistoryHooks({ before: () => {}, after: async () => {}, clear: vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined) })
    try {
      const fetcher = stubFetch(routes())
      const store = usePreviewStore()
      const first = store.selectTemplate(1, { versionId: 10 })
      await store.selectTemplate(2, { versionId: 21 })
      release()
      await first
      expect(store.currentTemplateId).toBe(2)
      expect(store.currentVersionId).toBe(21)
      expect(store.status).toBe('ready')
      expect(fetcher.mock.calls.some(call => String(call[0]).startsWith('/api/templates/1'))).toBe(false)
    } finally { registerHistoryHooks(null) }
  })

  it('较早的打开请求在文稿列表返回后也不能启动过期 PDF 或覆盖新稿', async () => {
    const fetcher = stubFetch({ ...routes(),
      '/api/templates/3': () => ({ default_version_id: 30 }),
      '/api/templates/3/versions': () => ({ versions: [{ id: 30, template_id: 3 }] }),
      '/api/versions/30/preview': () => new ArrayBuffer(3),
      '/api/versions/30/overlay': () => ({ regions: [] }),
    }, { '/api/templates/2/versions': 30 })
    const store = usePreviewStore()
    const first = store.selectTemplate(2, { versionId: 21 })
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.selectTemplate(3, { versionId: 30 })
    await first
    expect(store.currentTemplateId).toBe(3)
    expect(store.currentVersionId).toBe(30)
    expect(store.status).toBe('ready')
    expect(fetcher.mock.calls.some(call => String(call[0]) === '/api/versions/21/preview')).toBe(false)
  })
})

describe('区域检查的异步上下文保护', () => {
  const bbox = { page: 0, x0: 1, y0: 2, x1: 30, y1: 40 }
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(complete => { resolve = complete })
    return { promise, resolve }
  }
  function ready() {
    const store = usePreviewStore()
    store.currentTemplateId = 1; store.currentVersionId = 5; store.status = 'ready'
    store.regions = [{ ...region(1, bbox), binding: null }]
    store.pdfData = new ArrayBuffer(3)
    store.pageFingerprints = ['working-page']
    return store
  }
  it('模板详情未到达前保留整批工作稿，原文PDF与区域一起发布', async () => {
    const detail = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/preview')
      ? new Response(new ArrayBuffer(4)) : detail.promise))
    const store = ready()
    const previousPdf = store.pdfData
    const switching = store.toggleProofreadMode(true)
    await flushPromises()
    expect(store.pdfData).toBe(previousPdf)
    expect(store.pageFingerprints).toEqual(['working-page'])
    expect(store.regions[0].id).toBe(1)
    detail.resolve(Response.json({ regions: [region(2, bbox)] }))
    await switching
    expect(store.pdfData?.byteLength).toBe(4)
    expect(store.regions.map(r => r.id)).toEqual([2])
    expect(store.pageFingerprints).toEqual([])
  })
  it('读取PDF字节期间离开模板，旧字节不会覆盖已清空的新上下文', async () => {
    const bytes = deferred<ArrayBuffer>()
    const blob = new Blob()
    const read = vi.spyOn(blob, 'arrayBuffer').mockReturnValue(bytes.promise)
    const response = new Response()
    vi.spyOn(response, 'blob').mockResolvedValue(blob)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const store = ready()
    const switching = store.toggleProofreadMode(true)
    await flushPromises()
    expect(read).toHaveBeenCalledOnce()
    await store.selectTemplate(null)
    bytes.resolve(new ArrayBuffer(4))
    await switching
    expect(store.pdfData).toBeNull()
    expect(store.regions).toEqual([])
    expect(store.refreshing).toBe(false)
  })
  it('离开模板后旧切换失败，不把错误带进新上下文', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const store = ready()
    const switching = store.toggleProofreadMode(true)
    await store.selectTemplate(null)
    response.resolve(Response.json({ error: { code: 'FAILED', message: '旧转换失败' } }, { status: 500 }))
    await switching
    expect(store.status).toBe('idle')
    expect(store.error).toBeNull()
    expect(store.refreshing).toBe(false)
  })
  it('重复进入同一校对视图等待已有切换，而不是提前完成', async () => {
    const detail = deferred<Response>()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/preview')
      ? new Response(new ArrayBuffer(4)) : detail.promise)
    vi.stubGlobal('fetch', fetcher)
    const store = ready()
    const first = store.toggleProofreadMode(true)
    let completed = false
    const second = store.toggleProofreadMode(true).then(() => { completed = true })
    await flushPromises()
    expect(completed).toBe(false)
    detail.resolve(Response.json({ regions: [region(2, bbox)] }))
    await Promise.all([first, second])
    expect(completed).toBe(true)
    expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/preview'))).toHaveLength(1)
    expect(store.regions[0].id).toBe(2)
  })
  it.each([true, false])('模板渲染已开始时不改变视图模式（检查=%s）', async reviewing => {
    const rendering = deferred<Response>()
    let firstPreview = true
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/preview')) {
        if (firstPreview) { firstPreview = false; return rendering.promise }
        return new Response(new ArrayBuffer(url.startsWith('/api/templates/') ? 4 : 7))
      }
      if (url.endsWith('/versions')) return Response.json({ versions: [{ id: 22, name: '新版本' }] })
      if (url.endsWith('/overlay')) return Response.json({ regions: [{ ...region(2, bbox), binding: { block_id: 9, block_name: '当前内容', status: 'active' } }] })
      return Response.json({ default_version_id: 22, regions: [region(2, bbox)] })
    })
    vi.stubGlobal('fetch', fetcher)
    const store = ready()
    store.proofreadMode = reviewing
    const selecting = store.selectTemplate(2)
    await flushPromises()
    expect(store.status).toBe('loading')
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/preview'))).toBe(true)
    await store.toggleProofreadMode(!reviewing)
    const modeDuringLoad = store.proofreadMode
    rendering.resolve(new Response(new ArrayBuffer(reviewing ? 4 : 7)))
    await selecting
    expect(modeDuringLoad).toBe(reviewing)
    expect(store.proofreadMode).toBe(reviewing)
    expect(store.pdfData?.byteLength).toBe(reviewing ? 4 : 7)
    expect(store.regions[0].binding === null).toBe(reviewing)
    await store.toggleProofreadMode(!reviewing)
    expect(store.proofreadMode).toBe(!reviewing)
    expect(store.pdfData?.byteLength).toBe(reviewing ? 7 : 4)
    expect(store.regions[0].binding === null).toBe(!reviewing)
  })
  it('未选模板时可先进入检查，随后加载模板原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/templates/1/preview') return new Response(new ArrayBuffer(4))
      if (url.endsWith('/versions')) return Response.json({ versions: [{ id: 5, name: '默认版本' }] })
      return Response.json({ default_version_id: 5, regions: [region(1, bbox)] })
    }))
    const store = usePreviewStore()
    await store.toggleProofreadMode(true)
    await store.selectTemplate(1)
    expect(store.proofreadMode).toBe(true)
    expect(store.status).toBe('ready')
    expect(store.pdfData?.byteLength).toBe(4)
    expect(store.regions[0].binding).toBeNull()
  })
  it.each([true, false])('切换转换失败时保留原视图，重试后才切换（检查=%s）', async reviewing => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/preview')) {
        if (fail) return Response.json({ error: { code: 'CONVERSION_FAILED', message: '转换失败' } }, { status: 500 })
        return new Response(new ArrayBuffer(url.startsWith('/api/templates/') ? 4 : 7))
      }
      if (url.endsWith('/overlay')) return Response.json({ regions: [{ ...region(2, bbox), binding: { block_id: 9, block_name: '当前内容', status: 'active' } }] })
      return Response.json({ regions: [region(2, bbox)] })
    }))
    const store = ready()
    store.proofreadMode = reviewing
    const previousPdf = store.pdfData
    const previousRegions = store.regions
    await store.toggleProofreadMode(!reviewing)
    expect(store.proofreadMode).toBe(reviewing)
    expect(store.pdfData).toBe(previousPdf)
    expect(store.regions).toBe(previousRegions)
    expect(store.error).toBe('转换失败')
    expect(store.refreshing).toBe(false)
    fail = false
    await store.toggleProofreadMode(!reviewing)
    expect(store.proofreadMode).toBe(!reviewing)
    expect(store.pdfData?.byteLength).toBe(reviewing ? 7 : 4)
    expect(store.error).toBeNull()
  })
  it('返回转换失败恢复检查视图，也不重新接收切换前的旧保存', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response.promise
      if (String(input).endsWith('/preview')) return Response.json({ error: { code: 'FAILED', message: '转换失败' } }, { status: 500 })
      return Response.json({ templates: [] })
    }))
    const store = ready()
    store.proofreadMode = true
    const saving = store.confirmRegion(1)
    await store.toggleProofreadMode(false)
    response.resolve(Response.json({ ...region(1, bbox), label: '旧保存结果', review_status: 'confirmed' }))
    await saving
    expect(store.proofreadMode).toBe(true)
    expect(store.regions[0].label).toBe('字段1')
    expect(store.regions[0].review_status).toBe('pending')
  })
  it('补选保存后已切换模板，成功结果不追加到新模板', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input) === '/api/templates'
      ? Promise.resolve(Response.json({ templates: [] })) : response.promise))
    const store = ready()
    store.proofreadMode = true
    const saving = store.createFrameRegion(bbox, '新增区域', 'custom')
    await store.selectTemplate(null)
    store.currentTemplateId = 2
    store.regions = [{ ...region(22, bbox), template_id: 2, binding: null }]
    response.resolve(Response.json(region(3, bbox), { status: 201 }))
    expect((await saving).ok).toBe(true)
    expect(store.regions.map(r => r.id)).toEqual([22])
  })
  it.each(['confirm', 'adjust', 'remove'] as const)('%s保存期间返回工作稿，不改写后续工作稿覆盖层', async action => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input) === '/api/templates'
      ? Promise.resolve(Response.json({ templates: [] })) : response.promise))
    const store = ready()
    store.proofreadMode = true
    const saving = action === 'confirm' ? store.confirmRegion(1)
      : action === 'adjust' ? store.adjustRegionBBox(1, { ...bbox, x1: 100 })
      : store.removeRegion(1)
    store.proofreadMode = false
    store.regions = [{ ...region(1, { ...bbox, y1: 200 }), label: '工作稿区域', binding: null }]
    response.resolve(action === 'remove' ? new Response(null, { status: 204 })
      : Response.json({ ...region(1, bbox), label: '旧校对结果', review_status: 'confirmed' }))
    expect((await saving).ok).toBe(true)
    expect(store.regions[0].label).toBe('工作稿区域')
    expect(store.regions[0].bbox?.y1).toBe(200)
  })
  it('离开后再回到同模板校对，旧保存不覆盖重新读取的区域', async () => {
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response.promise
      const url = String(input)
      if (url.endsWith('/preview')) return new Response(new ArrayBuffer(4))
      if (url.endsWith('/overlay')) return Response.json({ regions: [] })
      if (url === '/api/templates') return Response.json({ templates: [] })
      return Response.json({ regions: [{ ...region(1, bbox), label: '新读取区域' }] })
    }))
    const store = ready()
    store.proofreadMode = true
    const saving = store.confirmRegion(1)
    await store.toggleProofreadMode(false)
    await store.toggleProofreadMode(true)
    response.resolve(Response.json({ ...region(1, bbox), label: '旧保存区域', review_status: 'confirmed' }))
    expect((await saving).ok).toBe(true)
    expect(store.regions[0].label).toBe('新读取区域')
  })
  it.each([200, 500])('旧模板版本列表晚到(%s)，不覆盖新模板列表', async status => {
    const previous = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).includes('/templates/1/')
      ? previous.promise : Promise.resolve(Response.json({ versions: [{ id: 22, name: '新模板版本' }] }))))
    const store = ready()
    const older = store.loadVersionList()
    store.currentTemplateId = 2
    await store.loadVersionList()
    previous.resolve(Response.json(status === 200 ? { versions: [{ id: 11, name: '旧模板版本' }] }
      : { error: { code: 'FAILED', message: '旧请求失败' } }, { status }))
    await older
    expect(store.versions.map(v => v.id)).toEqual([22])
  })
  it('同模板两次刷新列表，较早请求不覆盖新结果', async () => {
    const previous = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => previous.promise)
      .mockResolvedValue(Response.json({ versions: [{ id: 12, name: '新读取版本' }] })))
    const store = ready()
    const older = store.loadVersionList()
    await store.loadVersionList()
    previous.resolve(Response.json({ versions: [{ id: 11, name: '旧读取版本' }] }))
    await older
    expect(store.versions.map(v => v.id)).toEqual([12])
  })
})

it('覆盖层使用下载 PDF 的批次，过期批次自动重新获取', async () => {
  let previewCalls = 0
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/preview')) {
      previewCalls++
      return new Response(new Uint8Array([previewCalls]).buffer, {
        headers: { 'X-Render-Token': `batch-${previewCalls}` },
      })
    }
    if (url.endsWith('render_token=batch-1')) {
      return Response.json({ error: { code: 'RENDER_BATCH_EXPIRED', message: '批次过期' } }, { status: 409 })
    }
    if (url.endsWith('render_token=batch-2')) return Response.json({ regions: [{ ...region(4, null), binding: null }] })
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  const store = usePreviewStore()
  store.currentVersionId = 8; store.status = 'ready'
  await store.refreshVersionRender()
  expect(previewCalls).toBe(2)
  expect(store.regions[0].id).toBe(4)
  expect(new Uint8Array(store.pdfData!)[0]).toBe(2)
  expect(store.error).toBeNull()
})

it('校对模式重新生成预览时保留模板原文，不切换为替换后的工作稿', async () => {
  const fetcher = stubFetch({
    '/api/templates/1/preview': () => new ArrayBuffer(8),
    '/api/templates/1': () => ({ regions: [region(1, null)] }),
  })
  const store = usePreviewStore()
  store.currentTemplateId = 1; store.currentVersionId = 8
  store.status = 'ready'; store.proofreadMode = true
  await store.refreshVersionRender()
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['/api/templates/1/preview', '/api/templates/1'])
  expect(store.proofreadMode).toBe(true)
  expect(store.regions[0].binding).toBeNull()
})

describe('删除模板', () => {
  it('删除当前模板清除预览、版本、迁移和导出警示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const store = usePreviewStore()
    store.currentTemplateId = 1
    store.currentVersionId = 4
    store.status = 'ready'
    store.regions = [{ ...region(3, null), binding: null }]
    store.pdfData = new Uint8Array([1, 2]).buffer
    store.templates = [1, 2].map(id => ({ id, filename: '模板', regions_count: 1, storage_name: '', sha256: '', status: 'ready', created_at: '', updated_at: '' }))
    expect(await store.removeTemplate(1)).toEqual({ ok: true, error: null })
    expect(store.currentTemplateId).toBeNull()
    expect(store.currentVersionId).toBeNull()
    expect(store.pdfData).toBeNull()
    expect(store.regions).toEqual([])
    expect(store.status).toBe('idle')
    expect(store.templates.map(t => t.id)).toEqual([2])
  })
  it('保护错误不改变当前工作台', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'TEMPLATE_IN_USE', message: '模板仍有有效绑定' } }, { status: 409 })))
    const store = usePreviewStore()
    store.currentTemplateId = 1
    store.status = 'ready'
    expect((await store.removeTemplate(1)).ok).toBe(false)
    expect(store.currentTemplateId).toBe(1)
    expect(store.status).toBe('ready')
  })
})

describe('loadTemplates', () => {
  it('成功写入列表', async () => {
    stubFetch({
      '/api/templates': () => ({ templates: [{ id: 3, filename: 'a.docx', regions_count: 2 }] }),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    expect(store.templates).toHaveLength(1)
    expect(store.templates[0].filename).toBe('a.docx')
    expect(store.templatesError).toBeNull()
  })

  it('失败写入错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const store = usePreviewStore()
    await store.loadTemplates()
    expect(store.templatesError).toBe('无法连接本地服务，请确认后端已启动')
    expect(store.templates).toHaveLength(0)
  })
})

describe('selectTemplate（版本路径，M6a 主路径）', () => {
  function versionRoutes(delay?: Record<string, number>) {
    return stubFetch(
      {
        '/api/templates/1': () => ({
          id: 1,
          filename: 't.docx',
          default_version_id: 5,
          regions: [region(1, null)],
        }),
        '/api/versions/5/preview': () => new ArrayBuffer(3),
        '/api/versions/5/overlay': () => ({
          regions: [
            {
              ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
              binding: { block_id: 9, block_name: '姓名块', status: 'active' },
            },
          ],
        }),
      },
      delay,
    )
  }

  it('有默认版本：走版本渲染，regions 带绑定态', async () => {
    versionRoutes()
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.status).toBe('ready')
    expect(store.currentVersionId).toBe(5)
    expect(store.pdfData?.byteLength).toBe(3)
    expect(store.regions[0].binding?.block_name).toBe('姓名块')
  })

  it('无版本历史模板：回退模板预览 + 原始区域（binding 恒 null）', async () => {
    stubFetch({
      '/api/templates/1': () => ({
        id: 1,
        filename: 'legacy.docx',
        default_version_id: null,
        regions: [region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })],
      }),
      '/api/templates/1/preview': () => new ArrayBuffer(7),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.currentVersionId).toBeNull()
    expect(store.pdfData?.byteLength).toBe(7)
    expect(store.regions[0].binding).toBeNull()
  })

  it('选 null 重置为 idle', async () => {
    const store = usePreviewStore()
    await store.selectTemplate(null)
    expect(store.status).toBe('idle')
    expect(store.pdfData).toBeNull()
    expect(store.regions).toHaveLength(0)
  })

  it('预览失败进入 error 态（如 LibreOffice 不可用）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({ error: { code: 'LIBREOFFICE_UNAVAILABLE', message: '未安装' } }, { status: 503 }),
      ),
    )
    const store = usePreviewStore()
    await store.selectTemplate(9)
    expect(store.status).toBe('error')
    expect(store.error).toBe('未安装')
    expect(store.pdfData).toBeNull()
  })

  it('P7 快速切换：慢的旧模板响应被丢弃，最终状态是新模板', async () => {
    stubFetch(
      {
        '/api/templates/1': () => ({ id: 1, filename: 'old.docx', default_version_id: 11, regions: [] }),
        '/api/templates/2': () => ({ id: 2, filename: 'new.docx', default_version_id: 22, regions: [] }),
        '/api/versions/11/preview': () => new ArrayBuffer(1),
        '/api/versions/22/preview': () => new ArrayBuffer(2),
        '/api/versions/11/overlay': () => ({ regions: [] }),
        '/api/versions/22/overlay': () => ({ regions: [region(2, null)] }),
      },
      { '/api/versions/11/preview': 80 },
    )
    const store = usePreviewStore()
    const p1 = store.selectTemplate(1) // 旧模板：慢（80ms）
    const p2 = store.selectTemplate(2) // 立即切新模板
    await Promise.all([p1, p2])
    expect(store.currentTemplateId).toBe(2)
    expect(store.status).toBe('ready')
    expect(store.regions[0].id).toBe(2)
    expect(store.pdfData?.byteLength).toBe(2)
  })
})

describe('绑定流（M6a）', () => {
  /**
   * 一次 stub 拿到底层 fetch fn：detail/preview/overlay 基础路由 +
   * 可选的 bindings 端点（POST 绑定 / DELETE 解绑）。
   */
  function bindableRoutes(bindingsHandler?: (init?: RequestInit) => Response) {
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/templates/1') {
        return Promise.resolve(
          Response.json({ id: 1, filename: 't.docx', default_version_id: 5, regions: [] }),
        )
      }
      if (url === '/api/versions/5/preview') {
        return Promise.resolve(new Response(new ArrayBuffer(3)))
      }
      if (url === '/api/versions/5/overlay') {
        return Promise.resolve(
          Response.json({
            regions: [
              {
                ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
                binding: { block_id: 9, block_name: '手机号块', status: 'active' },
              },
            ],
          }),
        )
      }
      if (bindingsHandler && url.startsWith('/api/versions/5/bindings')) {
        return Promise.resolve(bindingsHandler(init))
      }
      return Promise.resolve(Response.json({}, { status: 404 }))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('bindRegionToBlock：POST 绑定后刷新版本渲染', async () => {
    const fetchFn = bindableRoutes(() => Response.json({ ok: true }, { status: 200 }))
    const store = usePreviewStore()
    await store.selectTemplate(1)

    const ok = await store.bindRegionToBlock(1, 9)
    expect(ok).toBe(true)
    const post = fetchFn.mock.calls.find(
      c =>
        String(c[0]) === '/api/versions/5/bindings' &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(post).toBeDefined()
    // 刷新后 regions 已带新绑定态
    expect(store.regions[0].binding?.block_id).toBe(9)
    expect(store.refreshing).toBe(false)
  })

  it('bindRegionToBlock：绑定请求失败 → 返回 false 且 error 有值', async () => {
    bindableRoutes(() =>
      Response.json({ error: { code: 'BLOCK_NOT_FOUND', message: '块不存在' } }, { status: 404 }),
    )
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const ok = await store.bindRegionToBlock(1, 99)
    expect(ok).toBe(false)
    expect(store.error).toBe('块不存在')
  })

  it('unbindRegionFromBlock：DELETE 后刷新', async () => {
    const fetchFn = bindableRoutes(() => new Response(null, { status: 204 }))
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const ok = await store.unbindRegionFromBlock(1)
    expect(ok).toBe(true)
    const del = fetchFn.mock.calls.find(
      c =>
        String(c[0]) === '/api/versions/5/bindings/1' &&
        (c[1] as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(del).toBeDefined()
    // 刷新后 overlay 给出的绑定态以响应为准
    expect(store.regions[0].binding).not.toBeNull()
    expect(store.refreshing).toBe(false)
  })
})

describe('校对域（M5b）', () => {
  const BBOX = { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }

  /** 按「METHOD url」路由的 fetch 替身（校对动作需区分 POST/PATCH/DELETE）。 */
  function proofreadRoutes(handlers: Record<string, (init?: RequestInit) => Response>) {
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const handler = handlers[`${method} ${String(input)}`]
      if (handler === undefined) {
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }
      return Promise.resolve(handler(init))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  /** 基础路由：模板详情 + 模板/版本渲染 + 列表；opts 可覆盖/追加。 */
  function baseRoutes(opts: Record<string, (init?: RequestInit) => Response> = {}) {
    return proofreadRoutes({
      'GET /api/templates': () => Response.json({ templates: [] }),
      'GET /api/templates/1': () =>
        Response.json({
          id: 1,
          filename: 't.docx',
          default_version_id: 5,
          regions: [region(1, BBOX)],
        }),
      'GET /api/templates/1/preview': () => new Response(new ArrayBuffer(4)),
      'GET /api/versions/5/preview': () => new Response(new ArrayBuffer(3)),
      'GET /api/versions/5/overlay': () => Response.json({ regions: [] }),
      ...opts,
    })
  }

  async function readyProofreadStore(): Promise<ReturnType<typeof usePreviewStore>> {
    const store = usePreviewStore()
    store.proofreadMode = true // 直置旗标：区域级测试不依赖渲染切换
    await store.selectTemplate(1)
    expect(store.status).toBe('ready')
    return store
  }

  it('toggleProofreadMode：开 → 模板渲染，关 → 回版本渲染', async () => {
    baseRoutes()
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.pdfData?.byteLength).toBe(3) // 默认走版本渲染
    await store.toggleProofreadMode(true)
    expect(store.proofreadMode).toBe(true)
    expect(store.pdfData?.byteLength).toBe(4) // 校对对象是模板本体
    expect(store.regions[0].binding).toBeNull()
    await store.toggleProofreadMode(false)
    expect(store.pdfData?.byteLength).toBe(3) // 回版本渲染
  })

  it('confirmRegion：PATCH 状态机并同步本地 regions', async () => {
    const fetchFn = baseRoutes({
      'PATCH /api/regions/1': () =>
        Response.json({ ...region(1, BBOX), review_status: 'confirmed' }),
    })
    const store = await readyProofreadStore()
    const result = await store.confirmRegion(1)
    expect(result).toEqual({ ok: true, error: null })
    expect(store.regions[0].review_status).toBe('confirmed')
    const patch = fetchFn.mock.calls.find(
      c => String(c[0]) === '/api/regions/1' && (c[1] as RequestInit).method === 'PATCH',
    )
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({
      review_status: 'confirmed',
    })
  })

  it('excludeRegion / reopenRegion：排除后可重新校对', async () => {
    baseRoutes({
      'PATCH /api/regions/1': (init) => {
        const body = JSON.parse((init?.body as string) ?? '{}') as { review_status: string }
        return Response.json({ ...region(1, BBOX), review_status: body.review_status })
      },
    })
    const store = await readyProofreadStore()
    await store.excludeRegion(1)
    expect(store.regions[0].review_status).toBe('excluded')
    await store.reopenRegion(1)
    expect(store.regions[0].review_status).toBe('pending')
  })

  it('adjustRegionBBox：PATCH bbox 后本地 bbox 跟随（manual 保护由后端负责）', async () => {
    const newBBox = { page: 0, x0: 10, y0: 20, x1: 30, y1: 40 }
    baseRoutes({
      'PATCH /api/regions/1': () => Response.json({ ...region(1, newBBox) }),
    })
    const store = await readyProofreadStore()
    const result = await store.adjustRegionBBox(1, newBBox)
    expect(result.ok).toBe(true)
    expect(store.regions[0].bbox).toEqual(newBBox)
  })

  it('removeRegion：DELETE 后从本地 regions 移除', async () => {
    const fetchFn = baseRoutes({
      'DELETE /api/regions/1': () => new Response(null, { status: 204 }),
    })
    const store = await readyProofreadStore()
    expect(store.regions).toHaveLength(1)
    const result = await store.removeRegion(1)
    expect(result.ok).toBe(true)
    expect(store.regions).toHaveLength(0)
    const del = fetchFn.mock.calls.find(
      c => String(c[0]) === '/api/regions/1' && (c[1] as RequestInit).method === 'DELETE',
    )
    expect(del).toBeDefined()
  })

  it('createFrameRegion：POST 201 → 追加到 regions', async () => {
    const fetchFn = baseRoutes({
      'POST /api/templates/1/regions': () =>
        Response.json(
          { ...region(2, BBOX), anchor: { kind: 'p', path: [7] }, review_status: 'confirmed' },
          { status: 201 },
        ),
    })
    const store = await readyProofreadStore()
    const result = await store.createFrameRegion(BBOX, '工作经历一', 'work')
    expect(result.ok).toBe(true)
    expect(store.regions).toHaveLength(2)
    expect(store.regions[1].label).toBe('字段2')
    expect(store.regions[1].review_status).toBe('confirmed')
    const post = fetchFn.mock.calls.find(
      c => String(c[0]) === '/api/templates/1/regions' && (c[1] as RequestInit).method === 'POST',
    )
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      label: '工作经历一',
      type: 'work',
      bbox: BBOX,
    })
  })

  it('createFrameRegion：多段拦截 400 → ok=false 且 error 为后端 message', async () => {
    baseRoutes({
      'POST /api/templates/1/regions': () =>
        Response.json(
          { error: { code: 'REGION_FRAME_MULTI', message: '框选区域覆盖了多个段落，请逐段框选' } },
          { status: 400 },
        ),
    })
    const store = await readyProofreadStore()
    const result = await store.createFrameRegion(BBOX, '跨段区域', 'work')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('框选区域覆盖了多个段落，请逐段框选')
    expect(store.regions).toHaveLength(1) // 未追加
  })
})

describe('currentTemplate 计算属性', () => {
  it('从列表解析当前模板', async () => {
    stubFetch({
      '/api/templates': () => ({
        templates: [
          { id: 1, filename: 'one.docx', regions_count: 0 },
          { id: 2, filename: 'two.docx', regions_count: 3 },
        ],
      }),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    expect(store.currentTemplate).toBeNull()
    store.currentTemplateId = 2
    expect(store.currentTemplate?.filename).toBe('two.docx')
  })
})

describe('版本管理（M8）', () => {
  const VERSIONS = {
    versions: [
      { id: 5, template_id: 1, name: '默认版本', binding_count: 1, created_at: '', updated_at: '' },
      { id: 6, template_id: 1, name: '投递B岗', binding_count: 0, created_at: '', updated_at: '' },
    ],
  }

  /** 按「METHOD url」路由的 fetch 替身（版本管理需区分 POST/PATCH/DELETE）。 */
  function versionRoutes(opts: Record<string, (init?: RequestInit) => Response> = {}) {
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const handlers: Record<string, (init?: RequestInit) => Response> = {
        'GET /api/templates': () => Response.json({ templates: [] }),
        'GET /api/templates/1': () =>
          Response.json({ id: 1, filename: 't.docx', default_version_id: 5, regions: [] }),
        'GET /api/templates/1/versions': () => Response.json(VERSIONS),
        'GET /api/templates/1/preview': () => new Response(new ArrayBuffer(4)),
        'GET /api/versions/5/preview': () => new Response(new ArrayBuffer(5)),
        'GET /api/versions/5/overlay': () => Response.json({ regions: [] }),
        'GET /api/versions/6/preview': () => new Response(new ArrayBuffer(6)),
        'GET /api/versions/6/overlay': () => Response.json({ regions: [] }),
        'GET /api/versions/7/preview': () => new Response(new ArrayBuffer(7)),
        'GET /api/versions/7/overlay': () => Response.json({ regions: [] }),
        ...opts,
      }
      const handler = handlers[`${method} ${String(input)}`]
      if (handler === undefined) {
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }
      return Promise.resolve(handler(init))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('selectTemplate 顺带加载版本列表（下拉数据源）', async () => {
    versionRoutes()
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.versions).toHaveLength(2)
    expect(store.versions[0].name).toBe('默认版本')
    expect(store.versions[0].binding_count).toBe(1)
  })

  it('selectVersion：切换整体刷新（新版本渲染产物 + overlay）', async () => {
    versionRoutes()
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.pdfData?.byteLength).toBe(5)

    await store.selectVersion(6)
    expect(store.currentVersionId).toBe(6)
    expect(store.status).toBe('ready')
    expect(store.pdfData?.byteLength).toBe(6)
  })

  it('selectVersion：同版本幂等、校对模式下不响应', async () => {
    versionRoutes()
    const store = usePreviewStore()
    await store.selectTemplate(1)
    await store.selectVersion(5) // 同版本：不重复刷新
    expect(store.pdfData?.byteLength).toBe(5)

    await store.toggleProofreadMode(true)
    expect(store.proofreadMode).toBe(true)
    expect(store.error).toBeNull()
    await store.selectVersion(6) // 校对对象是模板本体，切版本不响应
    expect(store.currentVersionId).toBe(5)
  })

  it('createNewVersion：POST 复制底稿 → 刷新列表并切到新版本', async () => {
    const fetchFn = versionRoutes({
      'POST /api/templates/1/versions': () =>
        Response.json(
          { id: 7, template_id: 1, name: '投递A岗', binding_count: 0, created_at: '', updated_at: '' },
          { status: 201 },
        ),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)

    const result = await store.createNewVersion('投递A岗', true)
    expect(result.ok).toBe(true)
    const post = fetchFn.mock.calls.find(
      c =>
        String(c[0]) === '/api/templates/1/versions' &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      name: '投递A岗',
      copy_from: 5,
    })
    expect(store.currentVersionId).toBe(7) // 成功后切到新版本
    expect(store.pdfData?.byteLength).toBe(7)
    expect(store.status).toBe('ready')
  })

  it('createNewVersion：重名 409 → ok=false 且 currentVersionId 不变', async () => {
    versionRoutes({
      'POST /api/templates/1/versions': () =>
        Response.json(
          { error: { code: 'VERSION_NAME_TAKEN', message: '同模板下已存在同名版本「投递B岗」' } },
          { status: 409 },
        ),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const result = await store.createNewVersion('投递B岗', false)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('同模板下已存在同名版本「投递B岗」')
    expect(store.currentVersionId).toBe(5)
  })

  it('renameCurrentVersion：PATCH 后同步列表显示', async () => {
    versionRoutes({
      'PATCH /api/versions/5': () =>
        Response.json({ id: 5, template_id: 1, name: '主力版本', binding_count: 1, created_at: '', updated_at: '' }),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const result = await store.renameCurrentVersion('主力版本')
    expect(result.ok).toBe(true)
    expect(store.versions[0].name).toBe('主力版本')
  })

  it('deleteCurrentVersion：DELETE 后从列表移除并切到相邻版本', async () => {
    const fetchFn = versionRoutes({
      'DELETE /api/versions/5': () => new Response(null, { status: 204 }),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const result = await store.deleteCurrentVersion()
    expect(result.ok).toBe(true)
    const del = fetchFn.mock.calls.find(
      c => String(c[0]) === '/api/versions/5' && (c[1] as RequestInit).method === 'DELETE',
    )
    expect(del).toBeDefined()
    expect(store.versions).toHaveLength(1)
    expect(store.currentVersionId).toBe(6) // 同位前一个（唯一剩余）
    expect(store.status).toBe('ready')
  })

  it('deleteCurrentVersion：失败（如 LAST_VERSION）→ ok=false 且列表不变', async () => {
    versionRoutes({
      'DELETE /api/versions/5': () =>
        Response.json(
          { error: { code: 'LAST_VERSION', message: '模板至少保留一个内容版本' } },
          { status: 400 },
        ),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const result = await store.deleteCurrentVersion()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('模板至少保留一个内容版本')
    expect(store.versions).toHaveLength(2)
    expect(store.currentVersionId).toBe(5)
  })
})

describe('换模板迁移（M10）', () => {
  const PLAN = {
    source_version_id: 5,
    source_version_name: '默认版本',
    source_template_id: 1,
    target_template_id: 2,
    target_version_id: 6,
    auto: [
      {
        source_region_id: 11,
        source_label: '姓名',
        target_region_id: 21,
        target_label: '名字',
        block_id: 31,
        block_name: '姓名块',
      },
    ],
    candidates: [],
    unmatched: [],
  }

  /**
   * 双模板场景：模板 1（源，默认版本 5 带 1 个 active 绑定）→ 模板 2（目标，
   * 默认版本 6 空白）。opts 可覆盖任意路由（守门负例注入）。
   */
  function migrationRoutes(opts: Record<string, (init?: RequestInit) => Response> = {}) {
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const handlers: Record<string, (init?: RequestInit) => Response> = {
        'GET /api/templates': () =>
          Response.json({
            templates: [
              { id: 1, filename: 'old.docx', status: 'ready', regions_count: 1 },
              { id: 2, filename: 'new.docx', status: 'ready', regions_count: 1 },
            ],
          }),
        'GET /api/templates/1': () =>
          Response.json({ id: 1, filename: 'old.docx', default_version_id: 5, regions: [] }),
        'GET /api/templates/2': () =>
          Response.json({ id: 2, filename: 'new.docx', default_version_id: 6, regions: [] }),
        'GET /api/templates/2/preview': () => new Response(new ArrayBuffer(9)),
        'GET /api/templates/1/versions': () =>
          Response.json({
            versions: [
              { id: 5, template_id: 1, name: '默认版本', binding_count: 1, created_at: '', updated_at: '' },
            ],
          }),
        'GET /api/templates/2/versions': () =>
          Response.json({
            versions: [
              { id: 6, template_id: 2, name: '默认版本', binding_count: 0, created_at: '', updated_at: '' },
            ],
          }),
        'GET /api/versions/5/preview': () => new Response(new ArrayBuffer(5)),
        'GET /api/versions/5/overlay': () =>
          Response.json({
            regions: [
              {
                ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
                binding: { block_id: 9, block_name: '姓名块', status: 'active' },
              },
            ],
          }),
        'GET /api/versions/6/preview': () => new Response(new ArrayBuffer(6)),
        'GET /api/versions/6/overlay': () => Response.json({ regions: [] }),
        'POST /api/templates/2/migrate/plan': () => Response.json(PLAN),
        'POST /api/templates/2/migrate/apply': () =>
          Response.json({ version_id: 6, created: 1 }, { status: 201 }),
        ...opts,
      }
      const handler = handlers[`${method} ${String(input)}`]
      if (handler === undefined) {
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }
      return Promise.resolve(handler(init))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('切到 ready 空白新模板：触发迁移提示（源上下文完整）', async () => {
    migrationRoutes()
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    expect(store.migrationSource).toBeNull() // 首次选择不触发
    await store.selectTemplate(2)
    expect(store.migrationSource).toEqual({
      sourceVersionId: 5,
      sourceVersionName: '默认版本',
      sourceTemplateName: 'old.docx',
      sourceBindingCount: 1,
    })
  })

  it('不触发：源版本无 active 绑定', async () => {
    migrationRoutes({
      'GET /api/versions/5/overlay': () => Response.json({ regions: [] }),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    expect(store.migrationSource).toBeNull()
  })

  it('不触发：目标默认版本非空白（后端 plan 亦守门）', async () => {
    migrationRoutes({
      'GET /api/templates/2/versions': () =>
        Response.json({
          versions: [
            { id: 6, template_id: 2, name: '默认版本', binding_count: 2, created_at: '', updated_at: '' },
          ],
        }),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    expect(store.migrationSource).toBeNull()
  })

  it('不触发：目标模板未完成校对（status != ready）', async () => {
    migrationRoutes({
      'GET /api/templates': () =>
        Response.json({
          templates: [
            { id: 1, filename: 'old.docx', status: 'ready', regions_count: 1 },
            { id: 2, filename: 'new.docx', status: 'pending_review', regions_count: 1 },
          ],
        }),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    expect(store.migrationSource).toBeNull()
  })

  it('不触发：校对模式下（迁移只发生在版本模式）', async () => {
    migrationRoutes()
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    store.proofreadMode = true
    await store.selectTemplate(2)
    expect(store.migrationSource).toBeNull()
  })

  it('loadMigrationPlan：成功填充方案', async () => {
    migrationRoutes()
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    const ok = await store.loadMigrationPlan()
    expect(ok).toBe(true)
    expect(store.migrationPlan?.auto).toHaveLength(1)
    expect(store.migrationBusy).toBe(false)
    expect(store.migrationError).toBeNull()
  })

  it('loadMigrationPlan：失败写入 migrationError 并返回 false', async () => {
    migrationRoutes({
      'POST /api/templates/2/migrate/plan': () =>
        Response.json(
          { error: { code: 'MIGRATION_TARGET_NOT_BLANK', message: '目标默认版本已有绑定' } },
          { status: 409 },
        ),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    const ok = await store.loadMigrationPlan()
    expect(ok).toBe(false)
    expect(store.migrationError).toBe('目标默认版本已有绑定')
  })

  it('confirmMigration：成功后清提示、刷新版本列表与预览', async () => {
    const fetchFn = migrationRoutes()
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    const result = await store.confirmMigration([{ region_id: 21, block_id: 31 }])
    expect(result.ok).toBe(true)
    const post = fetchFn.mock.calls.find(
      c =>
        String(c[0]) === '/api/templates/2/migrate/apply' &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
    )
    expect(post).toBeDefined()
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
      source_version_id: 5,
      bindings: [{ region_id: 21, block_id: 31 }],
    })
    expect(store.migrationSource).toBeNull()
    expect(store.migrationPlan).toBeNull()
    expect(store.status).toBe('ready')
    expect(store.pdfData?.byteLength).toBe(6) // 迁移后版本渲染已刷新
  })

  it('confirmMigration：apply 409 → ok=false，提示保留可重试', async () => {
    migrationRoutes({
      'POST /api/templates/2/migrate/apply': () =>
        Response.json(
          { error: { code: 'MIGRATION_TARGET_NOT_BLANK', message: '目标默认版本非空白' } },
          { status: 409 },
        ),
    })
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    const result = await store.confirmMigration([{ region_id: 21, block_id: 31 }])
    expect(result.ok).toBe(false)
    expect(result.error).toBe('目标默认版本非空白')
    expect(store.migrationSource).not.toBeNull() // 弹层不关，可调整后重试
  })

  it('dismissMigration：跳过后清空全部迁移状态', async () => {
    migrationRoutes()
    const store = usePreviewStore()
    await store.loadTemplates()
    await store.selectTemplate(1)
    await store.selectTemplate(2)
    expect(store.migrationSource).not.toBeNull()
    store.dismissMigration()
    expect(store.migrationSource).toBeNull()
    expect(store.migrationPlan).toBeNull()
  })
})

describe('导出（M9，PRD 4.8 / D5）', () => {
  const FILE_NAME = '简历-默认版本-20260921.docx'
  const DISPOSITION = `attachment; filename*=utf-8''%E7%AE%80%E5%8E%86-%E9%BB%98%E8%AE%A4%E7%89%88%E6%9C%AC-20260921.docx`

  function exportRoutes(opts: {
    exportStatus?: number
    exportBody?: unknown
    overflow?: object | null
  } = {}) {
    const region1 = {
      ...region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 }),
      binding: { block_id: 9, block_name: '姓名块', status: 'active' },
    }
    if (opts.overflow !== undefined) {
      ;(region1 as Record<string, unknown>).overflow = opts.overflow
    }
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const key = `${method} ${String(input)}`
      if (key === 'POST /api/versions/5/export') {
        if (opts.exportStatus === 409) {
          return Promise.resolve(
            Response.json(opts.exportBody, { status: 409 }),
          )
        }
        if (opts.exportStatus !== undefined && opts.exportStatus !== 200) {
          return Promise.resolve(
            Response.json(opts.exportBody, { status: opts.exportStatus }),
          )
        }
        return Promise.resolve(
          new Response(new ArrayBuffer(11), {
            status: 200,
            headers: { 'content-disposition': DISPOSITION },
          }),
        )
      }
      const routes: Record<string, () => Response> = {
        'GET /api/templates': () =>
          Response.json({
            templates: [{ id: 1, filename: 'a.docx', status: 'ready', regions_count: 1 }],
          }),
        'GET /api/templates/1': () =>
          Response.json({ id: 1, filename: 'a.docx', default_version_id: 5, regions: [] }),
        'GET /api/templates/1/versions': () =>
          Response.json({
            versions: [
              { id: 5, template_id: 1, name: '默认版本', binding_count: 1, created_at: '', updated_at: '' },
            ],
          }),
        'GET /api/versions/5/preview': () => new Response(new ArrayBuffer(5)),
        'GET /api/versions/5/overlay': () => Response.json({ regions: [region1] }),
      }
      const handler = routes[key]
      return Promise.resolve(
        handler ? handler() : Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
      )
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('无大超出：直接 POST 导出，返回 blob 与解析后的文件名', async () => {
    const fn = exportRoutes({ overflow: null })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const r = await store.requestExport(false)
    expect(r.ok).toBe(true)
    expect(r.needConfirm).toBe(false)
    expect(r.blob?.size).toBe(11)
    expect(r.fileName).toBe(FILE_NAME)
    const calls = fn.mock.calls.filter(c => String(c[0]).includes('/export'))
    expect(calls).toHaveLength(1)
    expect((calls[0][1] as RequestInit).body).toBe('{"confirm_large_overflow":false}')
  })

  it('有大超出（本地判定）：不发请求直接弹警示清单', async () => {
    const fn = exportRoutes({
      overflow: { orig_height: 20, new_height: 70, ratio: 2.5, level: 'large', clipped: false, fixed_row: false },
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const r = await store.requestExport(false)
    expect(r.ok).toBe(false)
    expect(r.needConfirm).toBe(true)
    expect(store.exportWarnings).toEqual([
      { region_id: 1, label: '字段1', ratio: 2.5, clipped: false, fixed_row: false },
    ])
    expect(fn.mock.calls.filter(c => String(c[0]).includes('/export'))).toHaveLength(0)
  })

  it('确认后带 confirm_large_overflow:true 重发导出', async () => {
    const fn = exportRoutes({
      overflow: { orig_height: 20, new_height: 70, ratio: 2.5, level: 'large', clipped: false, fixed_row: false },
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const r = await store.requestExport(true)
    expect(r.ok).toBe(true)
    expect(r.fileName).toBe(FILE_NAME)
    const calls = fn.mock.calls.filter(c => String(c[0]).includes('/export'))
    expect((calls[0][1] as RequestInit).body).toBe('{"confirm_large_overflow":true}')
    store.dismissExportWarnings()
    expect(store.exportWarnings).toEqual([])
  })

  it('服务端 409 兜底（本地判定过期）：以响应 warnings 弹清单', async () => {
    exportRoutes({
      overflow: null, // 本地无大超出
      exportStatus: 409,
      exportBody: {
        error: { code: 'EXPORT_LARGE_OVERFLOW', message: '存在 1 处大超出，确认后将按重排结果导出' },
        warnings: [{ region_id: 1, label: '字段1', ratio: 1.5, clipped: false, fixed_row: false }],
      },
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const r = await store.requestExport(false)
    expect(r.ok).toBe(false)
    expect(r.needConfirm).toBe(true)
    expect(store.exportWarnings).toHaveLength(1)
    expect(store.exportError).toBeNull()
  })

  it('导出失败（写盘 500）：ok=false，exportError 可读', async () => {
    exportRoutes({
      exportStatus: 500,
      exportBody: { error: { code: 'EXPORT_WRITE_FAILED', message: '导出文件写入失败' } },
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    const r = await store.requestExport(false)
    expect(r.ok).toBe(false)
    expect(r.needConfirm).toBe(false)
    expect(store.exportError).toBe('导出文件写入失败')
  })
})

describe('uploadTemplate（顶栏「导入模板」）', () => {
  /** 方法+URL 双键路由 stub（上传链路 POST/GET 同路径不同义，stubFetch 按 URL 单键不够用）。 */
  function stubMethodFetch(routes: Record<string, () => unknown>) {
    const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`
      const handler = routes[key]
      if (handler === undefined) {
        return Promise.resolve(
          Response.json({ error: { code: 'NOT_FOUND', message: 'nope' } }, { status: 404 }),
        )
      }
      const body = handler()
      if (body instanceof ArrayBuffer) {
        return Promise.resolve(new Response(body, { status: 200 }))
      }
      return Promise.resolve(Response.json(body, { status: 200 }))
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  function uploadRoutes(reused: boolean) {
    return stubMethodFetch({
      'POST /api/templates': () => ({
        id: 7,
        filename: 'new.docx',
        storage_name: '7_new.docx',
        sha256: 'abc',
        status: 'pending_review',
        created_at: '',
        updated_at: '',
        regions: [],
        default_version_id: 9,
        reused,
      }),
      'GET /api/templates': () => ({
        templates: [{ id: 7, filename: 'new.docx', regions_count: 0 }],
      }),
      'GET /api/templates/7': () => ({
        id: 7,
        filename: 'new.docx',
        default_version_id: 9,
        regions: [],
      }),
      'GET /api/templates/7/versions': () => ({ versions: [] }),
      'GET /api/versions/9/preview': () => new ArrayBuffer(3),
      'GET /api/versions/9/overlay': () => ({ regions: [] }),
    })
  }

  it('成功：multipart POST → 刷新列表并选中新模板，返回 templateId', async () => {
    const fn = uploadRoutes(false)
    const store = usePreviewStore()
    const r = await store.uploadTemplate(new File(['docx'], 'new.docx'))
    expect(r).toEqual({ ok: true, error: null, templateId: 7, reused: false })
    expect(store.templates.map(t => t.id)).toEqual([7])
    expect(store.currentTemplateId).toBe(7)
    expect(store.status).toBe('ready')
    const post = fn.mock.calls.find(
      c => String(c[0]) === '/api/templates' && c[1]?.method === 'POST',
    )
    expect(post?.[1]?.body).toBeInstanceOf(FormData)
  })

  it('同内容重传（D10）：reused=true 仍选中原模板', async () => {
    uploadRoutes(true)
    const store = usePreviewStore()
    const r = await store.uploadTemplate(new File(['docx'], 'new.docx'))
    expect(r.reused).toBe(true)
    expect(store.currentTemplateId).toBe(7)
    expect(store.status).toBe('ready')
  })

  it('失败：返回可读错误且不动当前选择', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const store = usePreviewStore()
    const r = await store.uploadTemplate(new File(['x'], 'a.docx'))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('无法连接本地服务，请确认后端已启动')
    expect(store.currentTemplateId).toBeNull()
    expect(store.status).toBe('idle')
  })
})


describe('版本文字编辑保存', () => {
  it('校对模式阻止编辑，失败保留当前预览', async () => {
    const store = usePreviewStore()
    store.currentVersionId = 5
    store.currentTemplateId = 1
    store.status = 'ready'
    const oldPdf = new ArrayBuffer(3)
    store.pdfData = oldPdf
    const fetch = vi.fn(async () => Response.json({ error: { code: 'REGION_TEXT_CONFLICT', message: '内容已发生变化' } }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    store.proofreadMode = true
    expect((await store.editRegionText(1, '新文字', false, '旧文字')).ok).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    store.proofreadMode = false
    expect(await store.editRegionText(1, '新文字', false, '旧文字')).toEqual({ ok: false, error: '内容已发生变化' })
    expect(store.pdfData).toBe(oldPdf)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('保存后刷新块库与预览，发送原文冲突检查字段', async () => {
    const fetch = stubFetch({
      '/api/versions/5/regions/1/text': () => ({ block_id: 8, status: 'active' }),
      '/api/blocks': () => ({ blocks: [] }),
      '/api/tags': () => ({ tags: [] }),
      '/api/versions/5/preview': () => new ArrayBuffer(5),
      '/api/versions/5/overlay': () => ({ regions: [{ ...region(1, null), current_text: '新文字', binding: { block_id: 8, block_name: '编辑块', status: 'active' } }] }),
      '/api/templates/1/versions': () => ({ versions: [] }),
    })
    const store = usePreviewStore()
    store.currentTemplateId = 1
    store.currentVersionId = 5
    store.status = 'ready'
    expect((await store.editRegionText(1, '新文字', false, '旧文字')).ok).toBe(true)
    expect(store.regions[0].current_text).toBe('新文字')
    const init = (fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ content: '新文字', sync_block: false, expected_content: '旧文字' })
  })
})


it('切换到空模板立即清除旧导出警示与错误', async () => {
  const store = usePreviewStore()
  store.exportWarnings = [{ region_id: 1, label: '旧区域', ratio: 2, clipped: false, fixed_row: false }]
  store.exportError = '旧导出错误'
  await store.selectTemplate(null)
  expect(store.exportWarnings).toEqual([])
  expect(store.exportError).toBeNull()
})
