import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiFetch } from '../api/client'
import { registerHistoryHooks } from '../api/historyHooks'
interface HistoryStatus { supported?: boolean; undo_count: number; redo_count: number; undo_label: string; redo_label: string }
export const useHistoryStore = defineStore('history', () => {
  const enabled = ref(false)
  const undoCount = ref(0), redoCount = ref(0)
  const undoLabel = ref(''), redoLabel = ref('')
  const busy = ref(false), pending = ref(0), error = ref<string | null>(null)
  const canUndo = computed(() => enabled.value && !busy.value && pending.value === 0 && undoCount.value > 0)
  const canRedo = computed(() => enabled.value && !busy.value && pending.value === 0 && redoCount.value > 0)
  function accept(result: HistoryStatus): void {
    enabled.value = result.supported === true
    undoCount.value = result.undo_count ?? 0; redoCount.value = result.redo_count ?? 0
    undoLabel.value = result.undo_label ?? ''; redoLabel.value = result.redo_label ?? ''
  }
  async function refresh(): Promise<void> { accept(await apiFetch<HistoryStatus>('/api/history/status')) }
  async function clear(): Promise<void> {
    if (!enabled.value) return
    try { accept(await apiFetch<HistoryStatus>('/api/history/clear', { method: 'POST' })); error.value = null }
    catch (err) { error.value = err instanceof Error ? err.message : String(err) }
  }
  async function initialize(): Promise<void> {
    try { await refresh() } catch { enabled.value = false }
    if (!enabled.value) return
    registerHistoryHooks({
      before: () => { pending.value++; error.value = null },
      after: async () => {
        try { await refresh() } catch (err) { error.value = err instanceof Error ? err.message : String(err) }
        finally { pending.value = Math.max(0, pending.value - 1) }
      }, clear,
    })
  }
  async function move(redo: boolean, reload: () => Promise<void>): Promise<void> {
    if (redo ? !canRedo.value : !canUndo.value) return
    busy.value = true; error.value = null
    try {
      accept(await apiFetch<HistoryStatus>(`/api/history/${redo ? 'redo' : 'undo'}`, { method: 'POST' }))
      await reload()
    } catch (err) { error.value = err instanceof Error ? err.message : String(err) }
    finally { busy.value = false }
  }
  function dispose(): void { registerHistoryHooks(null) }
  return { enabled, undoCount, redoCount, undoLabel, redoLabel, canUndo, canRedo, busy, pending, error, initialize, refresh, clear, move, dispose }
})
