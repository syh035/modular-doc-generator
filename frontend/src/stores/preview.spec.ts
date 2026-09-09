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

describe('selectTemplate', () => {
  it('加载成功：PDF 先取、详情在后，regions 与 pdfData 就绪', async () => {
    const pdfBytes = new ArrayBuffer(3)
    stubFetch({
      '/api/templates/1/preview': () => pdfBytes,
      '/api/templates/1': () => ({ id: 1, filename: 't.docx', regions: [region(1, { page: 0, x0: 1, y0: 2, x1: 3, y1: 4 })] }),
    })
    const store = usePreviewStore()
    await store.selectTemplate(1)
    expect(store.status).toBe('ready')
    expect(store.currentTemplateId).toBe(1)
    expect(store.regions).toHaveLength(1)
    expect(store.pdfData).toBeInstanceOf(ArrayBuffer)
    expect(store.pdfData?.byteLength).toBe(3)
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
        '/api/templates/1/preview': () => new ArrayBuffer(1),
        '/api/templates/2/preview': () => new ArrayBuffer(2),
        '/api/templates/1': () => ({ id: 1, filename: 'old.docx', regions: [region(1, null)] }),
        '/api/templates/2': () => ({ id: 2, filename: 'new.docx', regions: [region(2, null)] }),
      },
      { '/api/templates/1/preview': 80 },
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

  it('currentTemplate 计算属性从列表解析当前模板', async () => {
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
