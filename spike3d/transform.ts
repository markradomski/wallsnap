/**
 * FloorGen plan data -> glTF world, as exported in townhouse-wallsnap-dev-3d.glb. Verified numerically against that file
 * (see README.md): two generic-artwork solids match their saved FloorGen items to 0.01 cm.
 *
 *   FloorGen plan: centimetres, x to the right, y DOWN the plan, rotation in degrees clockwise.
 *   glTF world:    metres, Y up.
 *
 *   X = plan x / 100
 *   Z = plan y / 100                      (no flip: the map keeps the plan's handedness)
 *   Y = (floor base + elevation) / 100    (floor base = summed heights of the floors below; ground = 0, first = 220 cm)
 *
 * An item's front faces plan direction n = (-sin θ, cos θ), which is world (X, Z) = (-sin θ, cos θ). A Three.js plane
 * faces +Z; rotating it about Y by -θ turns its normal onto n, and its local +X (image left-to-right) then points to the
 * right-hand side of someone standing in front of it, so the picture reads correctly, not mirrored.
 */

export type V3 = [number, number, number]

export const CM = 0.01 // plan centimetres -> glTF metres

export interface PlanItem {
  /** Centre of the item in the plan, cm. */
  x: number
  y: number
  /** Degrees clockwise. */
  rotation: number
  width: number
  height: number
  depth: number
  /** Height of the item's underside above its floor, cm. */
  elevation: number
}

export interface FloorRow {
  id: string
  height: number
}

/** Base height (cm) of a floor: the summed heights of the floors below it. `floors` must be ordered lowest first. */
export function floorBaseCm(floors: FloorRow[], floorId: string): number {
  const at = floors.findIndex((f) => f.id === floorId)
  if (at < 0) throw new Error(`Unknown floor ${floorId}`)
  return floors.slice(0, at).reduce((sum, f) => sum + f.height, 0)
}

export function planToWorld(x: number, y: number, elevation: number, baseCm: number): V3 {
  return [x * CM, (baseCm + elevation) * CM, y * CM]
}

const rad = (deg: number) => (deg * Math.PI) / 180

/** World-space (X, Z) direction an item's front faces. */
export function frontDirection(rotationDeg: number): { x: number; z: number } {
  const t = rad(rotationDeg)
  return { x: -Math.sin(t), z: Math.cos(t) }
}

/** Rotation about world Y (radians) that turns a +Z-facing plane to face the item's front. */
export const planeRotationY = (rotationDeg: number) => -rad(rotationDeg)

/** The plane's normal and its local +X axis (image left-to-right) in world space after rotating by `rotationY`. */
export function planeAxes(rotationY: number): { normal: V3; right: V3 } {
  return {
    normal: [Math.sin(rotationY), 0, Math.cos(rotationY)],
    right: [Math.cos(rotationY), 0, -Math.sin(rotationY)],
  }
}

export interface Placement {
  /** Centre of the textured plane (metres). */
  position: V3
  rotationY: number
  /** Unit front direction in world space. */
  normal: V3
}

/**
 * Where to put a textured plane so it lies on the front face of the item's generic solid: the solid's front face is
 * `depth/2` in front of its centre, and the plane sits a further `gapCm` in front of that to avoid z-fighting.
 */
export function placementFor(item: PlanItem, baseCm: number, gapCm = 0.2): Placement {
  const n = frontDirection(item.rotation)
  const out = item.depth / 2 + gapCm
  const position = planToWorld(item.x + n.x * out, item.y + n.z * out, item.elevation + item.height / 2, baseCm)
  return { position, rotationY: planeRotationY(item.rotation), normal: [n.x, 0, n.z] }
}

/** The largest size with the image's aspect ratio that fits inside the frame (never cropped, never stretched). */
export function fitContain(frameW: number, frameH: number, imageRatio: number): { width: number; height: number } {
  return frameW / frameH > imageRatio
    ? { width: frameH * imageRatio, height: frameH }
    : { width: frameW, height: frameW / imageRatio }
}

export interface Aabb {
  min: V3
  max: V3
}

/** Axis-aligned box (in cm, world axes X/Y/Z) of an item's generic solid: what the GLB must contain for that item. */
export function expectedAabbCm(item: PlanItem, baseCm: number): Aabb {
  const t = rad(item.rotation)
  const [c, s] = [Math.cos(t), Math.sin(t)]
  // Local axes in plan coordinates: width runs along (cos θ, sin θ), depth along the front (-sin θ, cos θ).
  const half = (w: number, d: number): [number, number] => [(Math.abs(c) * w + Math.abs(s) * d) / 2, (Math.abs(s) * w + Math.abs(c) * d) / 2]
  const [hx, hz] = half(item.width, item.depth)
  const y0 = baseCm + item.elevation
  return { min: [item.x - hx, y0, item.y - hz], max: [item.x + hx, y0 + item.height, item.y + hz] }
}

/** Largest per-axis difference between two boxes (same units). */
export function boxError(a: Aabb, b: Aabb): number {
  let worst = 0
  for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k]))
  return worst
}
