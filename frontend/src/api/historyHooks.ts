let hooks: { before: () => void; after: () => Promise<void>; clear: () => Promise<void> } | null = null
export function registerHistoryHooks(value: typeof hooks): void { hooks = value }
export function mutationHooks(path: string, init?: RequestInit) {
  return hooks && !path.startsWith('/api/history/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(init?.method ?? 'GET') ? hooks : null
}
export async function clearHistoryBoundary(): Promise<void> { await hooks?.clear() }
