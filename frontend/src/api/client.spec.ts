import { CancelledError, RequestSequencer, sequencedFetch } from '../api/client'
import { describe, expect, it, vi } from 'vitest'

describe('RequestSequencer（P7 过期响应丢弃）', () => {
  it('无并发时序号请求正常返回', async () => {
    const seq = new RequestSequencer()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: 1 }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sequencedFetch<{ value: number }>(seq, '/api/test')
    expect(result).toEqual({ value: 1 })
    vi.unstubAllGlobals()
  })

  it('旧请求的响应被后续请求取代时抛 CancelledError', async () => {
    const seq = new RequestSequencer()
    // 第一个请求慢（100ms），第二个请求快（10ms）后完成
    const slow = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, json: async () => ({ value: 'slow' }) }), 100),
        ),
    )
    const fast = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, json: async () => ({ value: 'fast' }) }), 10),
        ),
    )
    const fetchMock = vi.fn().mockImplementationOnce(slow).mockImplementationOnce(fast)
    vi.stubGlobal('fetch', fetchMock)

    const first = sequencedFetch<{ value: string }>(seq, '/api/test')
    const second = sequencedFetch<{ value: string }>(seq, '/api/test')

    // 慢的旧请求过期被丢弃
    await expect(first).rejects.toThrow(CancelledError)
    // 快的新请求正常拿到结果
    await expect(second).resolves.toEqual({ value: 'fast' })
    vi.unstubAllGlobals()
  })

  it('isCurrent 只认最新序号', () => {
    const seq = new RequestSequencer()
    const a = seq.next()
    const b = seq.next()
    expect(seq.isCurrent(a)).toBe(false)
    expect(seq.isCurrent(b)).toBe(true)
  })
})
