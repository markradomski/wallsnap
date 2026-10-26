import type { ApplyResult, Artwork, FloorSummary, ArtworkCollection, PlanContext, WalkData, WallState } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, typeof body.code === 'string' ? body.code : undefined)
  return body as T
}

export const getStatus = () => req<{ adapter: 'floorgen' | 'mock'; project: string; viewer3dUrl: string | null }>('/api/status')
export const getFloors = () => req<FloorSummary[]>('/api/floors')
/** With `itemId` (Reload) the saved artwork is read back by its FloorGen id. Read-only either way. */
export const getWall = (floor: string, wall: string, itemId?: string) =>
  req<WallState>(`/api/wall?floor=${encodeURIComponent(floor)}&wall=${encodeURIComponent(wall)}${itemId ? `&item=${encodeURIComponent(itemId)}` : ''}`)
export const putArtwork = (floorId: string, wallId: string, artwork: Artwork, rev: number, itemId: string | null) =>
  req<ApplyResult>('/api/artwork', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ floorId, wallId, artwork, rev, itemId }),
  })

/** Plan-space geometry for the 3D preview. Read-only. */
export const getPlan = (floor: string, wall: string, itemId?: string | null) =>
  req<PlanContext>(`/api/plan?floor=${encodeURIComponent(floor)}&wall=${encodeURIComponent(wall)}${itemId ? `&item=${encodeURIComponent(itemId)}` : ''}`)

/** Collision geometry for Walk mode. Read-only. */
export const getWalk = (floor: string) => req<WalkData>(`/api/walk?floor=${encodeURIComponent(floor)}`)

/** Every saved WallSnap artwork in the project (read-only), for the 3D preview. */
export const getArtworks = () => req<ArtworkCollection>('/api/artworks')
