import { apiFetch } from './client'

export interface Archive {
  id: number
  source_version_id: number
  name: string
  version_name: string
  template_name: string
  created_at: string
}

export async function listArchives(): Promise<Archive[]> {
  return (await apiFetch<{ archives: Archive[] }>('/api/archives')).archives
}

export function createArchive(versionId: number, name: string, confirmOverflow: boolean): Promise<Archive> {
  return apiFetch(`/api/versions/${versionId}/archives`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, confirm_large_overflow: confirmOverflow }),
  })
}

export function deleteArchive(id: number): Promise<void> {
  return apiFetch(`/api/archives/${id}`, { method: 'DELETE' })
}
