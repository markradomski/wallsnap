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

// ---- Resize handles ----

/** Which edges a handle moves: e = +u side (towards B), w = -u side (towards A), n = top (+v), s = bottom. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * Resize by dragging `handle` to wall-space point (u, v). The opposite edge(s) stay anchored, the moving
 * edge is clamped to the wall and the size limits, and it can never cross the anchor.
 */
export function resizeFromHandle(
  wall: WallDims,
  art: Artwork,
  handle: Handle,
  to: { u: number; v: number },
  keepRatio = false,
): Artwork {
  if (keepRatio) return resizeKeepingRatio(wall, art, handle, to)
  const e = extent(art)
  const maxH = Math.min(MAX_ART_HEIGHT, wall.height)
  let { u0, u1, v0, v1 } = e
  if (handle.includes('e')) u1 = clamp(to.u, u0 + MIN_SIZE, Math.min(wall.length, u0 + wall.length))
  if (handle.includes('w')) u0 = clamp(to.u, Math.max(0, u1 - wall.length), u1 - MIN_SIZE)
  if (handle.includes('n')) v1 = clamp(to.v, v0 + MIN_SIZE, Math.min(wall.height, v0 + maxH))
  if (handle.includes('s')) v0 = clamp(to.v, Math.max(0, v1 - maxH), v1 - MIN_SIZE)
  return { width: u1 - u0, height: v1 - v0, u: (u0 + u1) / 2, v: v0 }
}

/** Where a handle sits on the rectangle, in wall space. */
export function handlePoint(art: Artwork, handle: Handle): { u: number; v: number } {
  const e = extent(art)
  return {
    u: handle.includes('e') ? e.u1 : handle.includes('w') ? e.u0 : art.u,
    v: handle.includes('n') ? e.v1 : handle.includes('s') ? e.v0 : art.v + art.height / 2,
  }
}

// ---- Contextual dimension label ----

export interface LabelSize {
  /** Label size in screen pixels. */
  w: number
  h: number
}
export type LabelPlacement = 'above' | 'below' | 'inside'

/**
 * Where to draw the "W × H cm" label for the selected artwork, in wall space. It prefers a spot outside the artwork,
 * clear of the edge handles' hit areas (`clearancePx`), and stays inside the wall so it never meets the A/B or
 * dimension annotations. Sizes arrive in pixels and are converted with `pxPerCm`, so it is independent of SVG scale.
 */
export function dimensionLabelPlacement(
  wall: WallDims,
  art: Artwork,
  pxPerCm: number,
  label: LabelSize,
  clearancePx: number,
): { u: number; v: number; placement: LabelPlacement } {
  const e = extent(art)
  const need = clearancePx + label.h + 2
  const spaceAbove = (wall.height - e.v1) * pxPerCm
  const spaceBelow = e.v0 * pxPerCm
  const offset = (clearancePx + label.h / 2) / pxPerCm
  let placement: LabelPlacement
  let v: number
  if (spaceAbove >= need) {
    placement = 'above'
    v = e.v1 + offset
  } else if (spaceBelow >= need) {
    placement = 'below'
    v = e.v0 - offset
  } else {
    placement = 'inside'
    v = (e.v0 + e.v1) / 2
  }
  const half = label.w / 2 / pxPerCm
  const u = wall.length <= 2 * half ? wall.length / 2 : clamp(art.u, half, wall.length - half)
  return { u, v, placement }
}

// ---- Wall attachment (FloorGen has no permanent wall constraint, so it must be checked) ----

/** An item as FloorGen stores it: centre x/y in the plan, rotation in degrees clockwise, sizes in cm. */
export interface PlacedItem {
  x: number
  y: number
  rotation: number
  width: number
  height: number
  depth: number
  elevation: number
}

/** How far from "flush on the wall face" (cm) and from "facing the room" (degrees) still counts as attached. */
export const ATTACH_TOL_CM = 2
export const ATTACH_TOL_DEG = 2

const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

/**
 * Why an item is not hanging on this wall, or [] when it is. Checks the wall plane, the facing direction and that
 * the item's centre lies along the wall. It never moves or "corrects" the item: callers must not invent coordinates.
 */
export function offWallReasons(f: WallFrame, thickness: number, it: PlacedItem): string[] {
  const reasons: string[] = []
  const c = wallCoords(f, it)
  const off = c.perp - flushPerp(thickness, it.depth)
  if (Math.abs(off) > ATTACH_TOL_CM) {
    reasons.push(`It is ${round1(Math.abs(off))} cm ${off > 0 ? 'in front of' : 'behind'} the wall surface.`)
  }
  const turn = angleDiff(it.rotation, facingRotation(f.normal))
  if (turn > ATTACH_TOL_DEG) reasons.push(`It is turned ${round1(turn)}° away from facing into the room.`)
  if (c.u < 0 || c.u > f.length) reasons.push('Its centre is beyond the ends of this wall.')
  return reasons
}

/**
 * Proportional resize: the artwork's current width ÷ height is preserved exactly. A corner handle keeps the opposite
 * corner fixed; an edge handle keeps the opposite edge fixed and grows the other axis symmetrically about the centre.
 * The scale is clamped so the result stays inside the wall, within the 200 cm height limit and above the minimum size.
 */
function resizeKeepingRatio(wall: WallDims, art: Artwork, handle: Handle, to: { u: number; v: number }): Artwork {
  const e = extent(art)
  const east = handle.includes('e')
  const west = handle.includes('w')
  const north = handle.includes('n')
  const south = handle.includes('s')
  const centreU = art.u
  const centreV = art.v + art.height / 2

  const wantW = east ? to.u - e.u0 : west ? e.u1 - to.u : NaN
  const wantH = north ? to.v - e.v0 : south ? e.v1 - to.v : NaN
  const requested = Math.max(wantW / art.width || 0, wantH / art.height || 0)

  const lo = Math.max(MIN_SIZE / art.width, MIN_SIZE / art.height)
  let hi = Math.min(wall.length / art.width, Math.min(MAX_ART_HEIGHT, wall.height) / art.height)
  if (east) hi = Math.min(hi, (wall.length - e.u0) / art.width)
  if (west) hi = Math.min(hi, e.u1 / art.width)
  if (north) hi = Math.min(hi, (wall.height - e.v0) / art.height)
  if (south) hi = Math.min(hi, e.v1 / art.height)
  if (!east && !west) hi = Math.min(hi, (2 * Math.min(centreU, wall.length - centreU)) / art.width)
  if (!north && !south) hi = Math.min(hi, (2 * Math.min(centreV, wall.height - centreV)) / art.height)
  const scale = clamp(requested, lo, Math.max(lo, hi))

  const width = art.width * scale
  const height = art.height * scale
  const u0 = east ? e.u0 : west ? e.u1 - width : centreU - width / 2
  const v0 = north ? e.v0 : south ? e.v1 - height : centreV - height / 2
  return { width, height, u: u0 + width / 2, v: v0 }
}
