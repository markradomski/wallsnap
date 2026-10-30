/**
 * Walk-mode movement: a circle sliding among oriented rectangles, a first-person view state, and a safe start position in
 * front of the artwork. Pure TypeScript in plan centimetres, so it is tested without Three.js or a browser.
 */
import { EYE_CM, RADIUS_CM, distanceTo, isFree, pushOut, segmentHits, segmentsCross, type Obb, type V2 } from './walkGeometry'

export { EYE_CM, RADIUS_CM }

/** Walking speeds (cm per second) and look/turn rates. */
export const WALK_SPEED = 130
export const FAST_FACTOR = 1.7
export const MOUSE_RAD_PER_PX = 0.0022
export const KEY_TURN_RAD_PER_S = 1.8
export const MAX_PITCH = 1.2
/** A longer frame is treated as this long, so a stalled tab never teleports the walker. */
export const MAX_DT = 0.05
const MAX_SUBSTEP = RADIUS_CM * 0.4 // far below the radius, so a thin wall can never be skipped

export interface WalkState {
  x: number
  y: number
  /** Direction of view in the plan: forward is (cos heading, sin heading). */
  heading: number
  /** Up/down look, radians; 0 is level. */
  pitch: number
}
export interface Keys { forward: boolean; back: boolean; left: boolean; right: boolean; fast: boolean; turnLeft: boolean; turnRight: boolean }
export const NO_KEYS: Keys = { forward: false, back: false, left: false, right: false, fast: false, turnLeft: false, turnRight: false }
export const anyKey = (k: Keys) => k.forward || k.back || k.left || k.right || k.turnLeft || k.turnRight

/**
 * Move a circle by `delta`, sliding along whatever it meets. The move is cut into small steps; after each, the circle is pushed
 * out of any rectangle it overlaps (along the contact normal, which is what makes it slide). If a push cannot settle (a pinch
 * between two shapes) the step is refused, so the circle can never end up inside a collider.
 */
export function moveCircle(from: V2, delta: V2, colliders: Obb[], radius = RADIUS_CM): V2 {
  const dist = Math.hypot(delta.x, delta.y)
  if (dist < 1e-9) return from
  const steps = Math.ceil(dist / MAX_SUBSTEP)
  let p = from
  for (let i = 0; i < steps; i++) {
    let q: V2 = { x: p.x + delta.x / steps, y: p.y + delta.y / steps }
    for (let pass = 0; pass < 8; pass++) {
      let moved = false
      for (const o of colliders) {
        const out = pushOut(o, q, radius)
        if (out) {
          q = out
          moved = true
        }
      }
      if (!moved) break
    }
    if (!isFree(q, colliders, radius, 1e-3)) return p
    p = q
  }
  return p
}

export function applyLook(s: WalkState, dxPx: number, dyPx: number): WalkState {
  return { ...s, heading: s.heading + dxPx * MOUSE_RAD_PER_PX, pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, s.pitch - dyPx * MOUSE_RAD_PER_PX)) }
}

/** Advance one frame: keys and elapsed seconds in, new state out. Speed does not depend on the frame rate. */
export function stepWalk(s: WalkState, keys: Keys, dtSeconds: number, colliders: Obb[], radius = RADIUS_CM): WalkState {
  const dt = Math.max(0, Math.min(MAX_DT, dtSeconds))
  const heading = s.heading + ((keys.turnRight ? 1 : 0) - (keys.turnLeft ? 1 : 0)) * KEY_TURN_RAD_PER_S * dt
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0)
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0)
  if (f === 0 && r === 0) return { ...s, heading }
  const len = Math.hypot(f, r) // diagonals are not faster
  const speed = WALK_SPEED * (keys.fast ? FAST_FACTOR : 1) * dt
  const fx = Math.cos(heading)
  const fy = Math.sin(heading)
  // right of forward in the plan (x right, y down on the plan, as seen from above)
  const dx = ((f * fx) + r * -fy) / len * speed
  const dy = ((f * fy) + r * fx) / len * speed
  const p = moveCircle({ x: s.x, y: s.y }, { x: dx, y: dy }, colliders, radius)
  return { ...s, x: p.x, y: p.y, heading }
}

export const headingToward = (from: V2, to: V2) => Math.atan2(to.y - from.y, to.x - from.x)

export interface StartInput {
  /** The artwork's centre in the plan, and the unit plan vector from its wall into the room. */
  artwork: V2
  normal: V2
  colliders: Obb[]
  /** Wall centrelines of the storey: a start must not be on the other side of any of them. */
  walls: { a: V2; b: V2 }[]
  preferredCm?: number
}
export type StartResult = { ok: true; state: WalkState; distanceCm: number } | { ok: false; reason: string }

/**
 * A safe place to start: clear of every collider with a margin, in plain sight of the artwork, and in the artwork's own room
 * (the line to the artwork crosses no wall). The preferred spot is 2.5 m straight out from the artwork; if that is blocked the
 * nearest valid spot is used, searching other distances along the normal and then a fan of directions.
 */
export function findStart(i: StartInput): StartResult {
  const want = i.preferredCm ?? 250
  const margin = RADIUS_CM + 5
  const faceTarget: V2 = { x: i.artwork.x + i.normal.x * 3, y: i.artwork.y + i.normal.y * 3 }
  const valid = (p: V2) =>
    isFree(p, i.colliders, margin) &&
    // Furniture is below eye level, so a painting hung above a sofa is still in plain sight; walls and stairs block the view.
    !i.colliders.some((o) => o.kind !== 'furniture' && segmentHits(o, p, faceTarget)) &&
    !i.walls.some((w) => segmentsCross(p, faceTarget, w.a, w.b))
  const candidates: { p: V2; cost: number }[] = []
  const base = Math.atan2(i.normal.y, i.normal.x)
  for (let d = 80; d <= 500; d += 10) {
    for (let a = 0; a <= 70; a += 10) {
      for (const sign of a === 0 ? [1] : [1, -1]) {
        const t = base + sign * (a * Math.PI) / 180
        candidates.push({ p: { x: i.artwork.x + Math.cos(t) * d, y: i.artwork.y + Math.sin(t) * d }, cost: Math.abs(d - want) + a * 1.5 })
      }
    }
  }
  candidates.sort((p, q) => p.cost - q.cost)
  const hit = candidates.find((c) => valid(c.p))
  if (!hit) return { ok: false, reason: 'No clear spot was found in front of the artwork (the room around it is too tight to stand in).' }
  return {
    ok: true,
    state: { x: hit.p.x, y: hit.p.y, heading: headingToward(hit.p, i.artwork), pitch: 0 },
    distanceCm: Math.hypot(hit.p.x - i.artwork.x, hit.p.y - i.artwork.y),
  }
}

/** Distance from a point to the nearest collider surface (diagnostics and tests). */
export const clearance = (p: V2, colliders: Obb[]) => Math.min(Infinity, ...colliders.map((o) => distanceTo(o, p)))

// -- pointer-lock lifecycle --

export type WalkPhase = 'off' | 'ready' | 'locked'
export type WalkEvent = 'enter' | 'exit' | 'lock' | 'unlock' | 'escape'
/**
 * `enter` starts Walk mode without capturing the mouse; `lock`/`unlock` follow the browser's pointer-lock changes (Escape
 * makes the browser unlock, after which Walk mode is still on); `exit` always returns to `off`.
 */
export function walkPhase(phase: WalkPhase, ev: WalkEvent): WalkPhase {
  switch (ev) {
    case 'enter': return phase === 'off' ? 'ready' : phase
    case 'exit': return 'off'
    case 'lock': return phase === 'off' ? 'off' : 'locked'
    case 'unlock':
    case 'escape': return phase === 'locked' ? 'ready' : phase
  }
}
