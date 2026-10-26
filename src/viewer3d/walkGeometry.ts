/**
 * Collision shapes for Walk mode, built from FloorGen's own plan data (walls with thickness, door/window spans, furniture
 * and stair footprints). Pure functions in plan centimetres: nothing here knows about Three.js, and nothing is reconstructed
 * from the exported 3D mesh. Every shape is an oriented rectangle, which keeps the movement maths exact and easy to test.
 */
import type { StairInfo, WalkData } from '../types'

export interface V2 { x: number; y: number }

/** An oriented rectangle: centre, unit axes u and v (v = u turned 90 degrees), half-extents along each. */
export interface Obb {
  id: string
  kind: 'wall' | 'furniture' | 'stair' | 'cutout'
  cx: number
  cy: number
  ux: number
  uy: number
  hu: number
  hv: number
}

/** Walk-mode body and limits (cm). */
export const EYE_CM = 160
export const RADIUS_CM = 25
/** Doorways need this much clear height at the eye line, and at most this sill, to be walked through. */
export const DOOR_MIN_HEIGHT_CM = 170
export const DOOR_MAX_SILL_CM = 5
/** Furniture hanging at or above this height (wall cabinets, shelves) passes over a walking person's waist; lower pieces block. */
export const BLOCKING_ELEVATION_CM = 90
/** Objects lower than this above their elevation (rugs, mats) are walked over. */
export const MIN_BLOCKING_TOP_CM = 20
/** Tag FloorGen items carry when WallSnap placed them. The artwork hangs on a wall and never blocks. */
export const ARTWORK_TAG = 'wallsnap'

const rad = (deg: number) => (deg * Math.PI) / 180

/** A centred rectangle with `half` extents along the axis at `angleDeg` (clockwise rotation, y down, as FloorGen stores it). */
export function orientedRect(id: string, kind: Obb['kind'], c: V2, angleDeg: number, halfAlong: number, halfAcross: number): Obb {
  const t = rad(angleDeg)
  return { id, kind, cx: c.x, cy: c.y, ux: Math.cos(t), uy: Math.sin(t), hu: halfAlong, hv: halfAcross }
}

/**
 * True when an opening can be walked through at floor level: not a window (even a tall one is glass), no sill to climb, a
 * lintel above eye height, and not a door to the outside (there is no floor out there). Closed or open leaves are not
 * known from FloorGen, so every such doorway is treated as open.
 */
export function isTraversable(o: WalkData['openings'][number]): boolean {
  return !o.exterior && o.kind !== 'window' && o.sill <= DOOR_MAX_SILL_CM && o.height >= DOOR_MIN_HEIGHT_CM
}

/** Solid stretches of a wall, in distance from endpoint A, once traversable doorways are removed. */
export function solidSpans(length: number, gaps: [number, number][]): [number, number][] {
  const sorted = gaps.map(([a, b]) => [Math.max(0, a), Math.min(length, b)] as [number, number]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])
  const out: [number, number][] = []
  let at = 0
  for (const [a, b] of sorted) {
    if (a > at) out.push([at, a])
    at = Math.max(at, b)
  }
  if (at < length) out.push([at, length])
  return out
}

function stairRect(s: StairInfo, grow: number, kind: 'stair' | 'cutout'): Obb {
  const run = s.steps * s.treadDepth + s.nosing
  // The run direction is the stair's rotation turned a quarter (rotation 0 runs along y), the width lies across it.
  return orientedRect(`${kind}:${s.id}`, kind, { x: s.x, y: s.y }, s.rotation, s.width / 2 + grow, run / 2 + grow)
}

/** Everything the walker cannot pass at floor level on this storey. */
export function buildColliders(d: WalkData): Obb[] {
  const out: Obb[] = []
  for (const w of d.walls) {
    const dx = w.b.x - w.a.x
    const dy = w.b.y - w.a.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) continue
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI
    const gaps = d.openings
      .filter((o) => o.wallId === w.id && isTraversable(o))
      .map((o) => [o.offset - o.width / 2, o.offset + o.width / 2] as [number, number])
    const half = w.thickness / 2
    for (const [s0, s1] of solidSpans(len, gaps)) {
      // Spans that reach an endpoint extend by half the thickness so wall corners close without a notch.
      const from = s0 <= 1e-9 ? -half : s0
      const to = s1 >= len - 1e-9 ? len + half : s1
      const mid = (from + to) / 2
      out.push(orientedRect(`wall:${w.id}:${Math.round(s0)}`, 'wall', { x: w.a.x + (dx / len) * mid, y: w.a.y + (dy / len) * mid }, angle, (to - from) / 2, half))
    }
  }
  for (const i of d.items) {
    if (i.tag === ARTWORK_TAG) continue
    if (i.elevation >= BLOCKING_ELEVATION_CM || i.elevation + i.height <= MIN_BLOCKING_TOP_CM) continue
    out.push(orientedRect(`item:${i.id}`, 'furniture', { x: i.x, y: i.y }, i.rotation, i.width / 2, i.depth / 2))
  }
  for (const s of d.stairs) out.push(stairRect(s, 0, 'stair'))
  for (const s of d.stairsBelow) if (s.cutOpening) out.push(stairRect(s, s.wellGap, 'cutout'))
  return out
}

/** Where `p` sits in a rectangle's own axes. */
function local(o: Obb, p: V2): V2 {
  const rx = p.x - o.cx
  const ry = p.y - o.cy
  return { x: rx * o.ux + ry * o.uy, y: -rx * o.uy + ry * o.ux }
}

/** Distance from `p` to the rectangle (0 when inside). */
export function distanceTo(o: Obb, p: V2): number {
  const l = local(o, p)
  return Math.hypot(Math.max(Math.abs(l.x) - o.hu, 0), Math.max(Math.abs(l.y) - o.hv, 0))
}

/**
 * Smallest move that takes a circle of `radius` centred at `p` out of the rectangle, or null if it is not touching it.
 * A centre inside the rectangle leaves by the nearest face.
 */
export function pushOut(o: Obb, p: V2, radius: number): V2 | null {
  const l = local(o, p)
  const qx = Math.max(-o.hu, Math.min(o.hu, l.x))
  const qy = Math.max(-o.hv, Math.min(o.hv, l.y))
  let nx: number
  let ny: number
  let depth: number
  if (qx === l.x && qy === l.y) {
    // centre inside: leave through the nearest face
    const toU = o.hu - Math.abs(l.x)
    const toV = o.hv - Math.abs(l.y)
    if (toU < toV) {
      nx = Math.sign(l.x) || 1
      ny = 0
      depth = toU + radius
    } else {
      nx = 0
      ny = Math.sign(l.y) || 1
      depth = toV + radius
    }
  } else {
    const dx = l.x - qx
    const dy = l.y - qy
    const dist = Math.hypot(dx, dy)
    if (dist >= radius) return null
    nx = dx / dist
    ny = dy / dist
    depth = radius - dist
  }
  // back to plan axes: u = (ux, uy), v = (-uy, ux)
  return { x: p.x + (nx * o.ux - ny * o.uy) * depth, y: p.y + (nx * o.uy + ny * o.ux) * depth }
}

/** True when the circle overlaps no rectangle (touching is allowed). */
export function isFree(p: V2, colliders: Obb[], radius: number, slack = 1e-6): boolean {
  return colliders.every((o) => pushOut(o, p, radius - slack) === null)
}

/** Does the segment a-b pass through the rectangle? (Slab test in the rectangle's own axes.) */
export function segmentHits(o: Obb, a: V2, b: V2): boolean {
  const p = local(o, a)
  const q = local(o, b)
  let t0 = 0
  let t1 = 1
  for (const [s, e, h] of [[p.x, q.x, o.hu], [p.y, q.y, o.hv]] as const) {
    const d = e - s
    if (Math.abs(d) < 1e-12) {
      if (Math.abs(s) > h) return false
      continue
    }
    let near = (-h - s) / d
    let far = (h - s) / d
    if (near > far) [near, far] = [far, near]
    t0 = Math.max(t0, near)
    t1 = Math.min(t1, far)
    if (t0 > t1) return false
  }
  return true
}

/** Do two segments cross? (Used against wall centrelines, which carry no gap for doorways.) */
export function segmentsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const cross = (p: V2, q: V2, r: V2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}
