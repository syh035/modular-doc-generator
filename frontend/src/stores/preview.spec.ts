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
