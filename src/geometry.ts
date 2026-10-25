import type { Artwork, Opening } from './types'

export const MAX_ART_HEIGHT = 200
export const MIN_SIZE = 1
const EPS = 1e-6

export interface WallDims {
  length: number
  height: number
}

export const round1 = (n: number) => Math.round(n * 10) / 10

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Keep the artwork fully inside the wall and its size within limits. */
export function clampToWall(wall: WallDims, art: Artwork): Artwork {
  const width = clamp(art.width, MIN_SIZE, wall.length)
  const height = clamp(art.height, MIN_SIZE, Math.min(MAX_ART_HEIGHT, wall.height))
  return {
    width,
    height,
    u: clamp(art.u, width / 2, wall.length - width / 2),
    v: clamp(art.v, 0, wall.height - height),
  }
}

/** Move by (du, dv) cm, then clamp. +dv is up. */
export function nudge(wall: WallDims, art: Artwork, du: number, dv: number): Artwork {
  return clampToWall(wall, { ...art, u: art.u + du, v: art.v + dv })
}

/** Rectangle extent: u0..u1 along the wall from A, v0..v1 above the floor. */
export const extent = (a: Artwork) => ({
  u0: a.u - a.width / 2,
  u1: a.u + a.width / 2,
  v0: a.v,
  v1: a.v + a.height,
})

export function overlapsOpening(a: Artwork, o: Opening): boolean {
  const e = extent(a)
  return (
    e.u0 < o.left + o.width - EPS &&
    e.u1 > o.left + EPS &&
    e.v0 < o.sill + o.height - EPS &&
    e.v1 > o.sill + EPS
  )
}

/** Returns human-readable problems; empty when the placement is valid. */
export function validate(wall: WallDims & { openings: Opening[] }, art: Artwork): string[] {
  if (![art.width, art.height, art.u, art.v].every(Number.isFinite)) return ['All values must be numbers.']
  const errors: string[] = []
  if (art.width < MIN_SIZE) errors.push(`Width must be at least ${MIN_SIZE} cm.`)
  if (art.height < MIN_SIZE) errors.push(`Height must be at least ${MIN_SIZE} cm.`)
  if (art.height > MAX_ART_HEIGHT) errors.push(`Height cannot exceed ${MAX_ART_HEIGHT} cm.`)
  if (art.width > wall.length + EPS) errors.push(`Width cannot exceed the wall length (${round1(wall.length)} cm).`)
  const e = extent(art)
  if (e.u0 < -EPS || e.u1 > wall.length + EPS) errors.push('Artwork extends past the wall ends.')
  if (e.v0 < -EPS) errors.push('Bottom height cannot be below the floor.')
  if (e.v1 > wall.height + EPS) errors.push(`Top edge exceeds the wall height (${round1(wall.height)} cm).`)
  if (wall.openings.some((o) => overlapsOpening(art, o))) errors.push('Artwork overlaps a door or window.')
  return errors
}

// ---- Wall <-> plan conversion (used by the server adapter) ----

export interface Pt {
  x: number
  y: number
}

export interface WallFrame {
  a: Pt
  b: Pt
  /** Unit vector from endpoint A to endpoint B. */
  dir: Pt
  /** Unit vector from the wall towards the room (the face the artwork hangs on). */
  normal: Pt
  length: number
}

/** A is authoritative: u always runs from `a`. `roomCentroid` only picks which face is hung on. */
export function wallFrame(a: Pt, b: Pt, roomCentroid: Pt): WallFrame {
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  if (!Number.isFinite(length) || length < 1) throw new Error('Degenerate wall: endpoints coincide.')
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
  let normal = { x: -dir.y || 0, y: dir.x || 0 }
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  if ((roomCentroid.x - mid.x) * normal.x + (roomCentroid.y - mid.y) * normal.y < 0) {
    normal = { x: -normal.x || 0, y: -normal.y || 0 }
  }
  return { a, b, dir, normal, length }
}

/** FloorGen item rotation (degrees clockwise, 0..360) that makes the item front face `normal`. */
export function facingRotation(normal: Pt): number {
  const deg = (Math.atan2(-normal.x, normal.y) * 180) / Math.PI
  return ((Math.round(deg * 1000) / 1000) % 360 + 360) % 360
}

/** Plan point at distance `u` from A along the wall, pushed `perp` cm out towards the room. */
export function planPoint(f: WallFrame, u: number, perp: number): Pt {
  return { x: f.a.x + f.dir.x * u + f.normal.x * perp, y: f.a.y + f.dir.y * u + f.normal.y * perp }
}

/** Inverse of planPoint. */
export function wallCoords(f: WallFrame, p: Pt): { u: number; perp: number } {
  const dx = p.x - f.a.x
  const dy = p.y - f.a.y
  return { u: dx * f.dir.x + dy * f.dir.y, perp: dx * f.normal.x + dy * f.normal.y }
}

/** Distance from the wall centreline for an item of `depth` to sit flush on a wall of `thickness`. */
export const flushPerp = (thickness: number, depth: number) => thickness / 2 + depth / 2
