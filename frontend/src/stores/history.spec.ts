import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from '../api/client'
import { useHistoryStore } from './history'
const state = (undo = 1, redo = 0) => ({ supported: true, undo_count: undo, redo_count: redo, undo_label: '修改绑定', redo_label: '修改绑定' })
afterEach(() => { useHistoryStore().dispose(); vi.unstubAllGlobals() })
describe('全局撤销状态', () => {
  it('mutation 等待期间锁定，204 完成后刷新；撤销恢复数据再解锁', async () => {
    setActivePinia(createPinia())
    let resolveMutation!: (value: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(state()))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveMutation = resolve }))
      .mockResolvedValueOnce(Response.json(state(2)))
      .mockResolvedValueOnce(Response.json(state(1, 1)))
    vi.stubGlobal('fetch', fetcher)
    const history = useHistoryStore()
    await history.initialize()
    expect(history.canUndo).toBe(true)
    const deleting = apiFetch('/api/blocks/1', { method: 'DELETE' })
    expect(history.pending).toBe(1); expect(history.canUndo).toBe(false)
    resolveMutation(new Response(null, { status: 204 })); await deleting
    expect(history.undoCount).toBe(2); expect(history.pending).toBe(0)
    const reload = vi.fn().mockResolvedValue(undefined)
    await history.move(false, reload)
    expect(reload).toHaveBeenCalledOnce(); expect(history.redoCount).toBe(1)
    expect(fetcher.mock.calls[3]?.[0]).toBe('/api/history/undo')
  })
  it('冲突保留记录并展示错误，清空是显式恢复路径', async () => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(state()))
      .mockResolvedValueOnce(Response.json({ error: { code: 'HISTORY_CONFLICT', message: '其他操作改变数据' } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json(state(0, 0))))
    const history = useHistoryStore(); await history.initialize()
    const reload = vi.fn()
    await history.move(false, reload)
    expect(history.error).toBe('其他操作改变数据'); expect(reload).not.toHaveBeenCalled()
    expect(history.undoCount).toBe(1)
    await history.clear(); expect(history.undoCount).toBe(0); expect(history.error).toBeNull()
  })
})
