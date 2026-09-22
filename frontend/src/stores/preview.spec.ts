import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Region } from '../api/templates'
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
