import type { ApplyResult, Artwork, FloorSummary, WallState } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status)
  return body as T
}

export const getStatus = () => req<{ adapter: 'floorgen' | 'mock'; project: string; viewer3dUrl: string | null }>('/api/status')
export const getFloors = () => req<FloorSummary[]>('/api/floors')
export const getWall = (floor: string, wall: string) =>
  req<WallState>(`/api/wall?floor=${encodeURIComponent(floor)}&wall=${encodeURIComponent(wall)}`)
export const putArtwork = (floorId: string, wallId: string, artwork: Artwork, rev: number) =>
  req<ApplyResult>('/api/artwork', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ floorId, wallId, artwork, rev }),
  })
