/**
 * The viewer's restrained "look", as pure functions so it can be tested without a GPU. The GLB carries colours only (one
 * identical property set on all 21 materials: metallic 0, roughness 0.9, no textures, no UVs), so presentation comes from
 * lighting, shadows, tone mapping, a per-category finish and the camera, never from invented detail.
 */
import type { V3 } from './transform'

export type Category = 'walls' | 'floors' | 'furniture' | 'stairs'

/** Category from a node or mesh name such as "First Floor — Living / Dining / Kitchen walls" or its sanitised form. */
export function categoryOf(name: string): Category | null {
  const m = /(walls|floors|furniture|stairs)$/i.exec(name.trim())
  return m ? (m[1].toLowerCase() as Category) : null
}

export interface Finish {
  roughness: number
  metalness: number
  castShadow: boolean
  receiveShadow: boolean
  /** Depth bias towards the camera (WebGL polygon offset), or null for none. */
  depthBias: { factor: number; units: number } | null
}

/**
 * FloorGen's slab is a single flat surface at the storey's base height (Y = 2.2 m for the first floor), and the walls of the
 * storey below end in cap faces at exactly that height, so the two are coplanar and fight for the pixel: streaks and dotted
 * lines on the floor, worst around stairwell openings where the caps are exposed. Pulling the slab a hair towards the camera
 * lets it win everywhere it exists and changes nothing else: the openings in it stay open, and no coordinates move.
 */
export const FLOOR_DEPTH_BIAS = { factor: -1, units: -2 }

/**
 * Subtle, justified differences only. FloorGen exports every surface as matte (roughness 0.9); floors read slightly
 * softer, painted architecture stays matte, and furniture gets a little sheen. Nothing is metallic: the file has no
 * way to say which surfaces are.
 */
export function finishFor(category: Category | null): Finish {
  switch (category) {
    case 'walls': return { roughness: 0.92, metalness: 0, castShadow: true, receiveShadow: true, depthBias: null }
    case 'floors': return { roughness: 0.95, metalness: 0, castShadow: false, receiveShadow: true, depthBias: FLOOR_DEPTH_BIAS }
    case 'furniture': return { roughness: 0.7, metalness: 0, castShadow: true, receiveShadow: true, depthBias: null }
    case 'stairs': return { roughness: 0.85, metalness: 0, castShadow: true, receiveShadow: true, depthBias: null }
    default: return { roughness: 0.9, metalness: 0, castShadow: false, receiveShadow: false, depthBias: null }
  }
}

/** FloorGen names each material after its colour, e.g. "#f5f2e9-0". */
export function colourOfMaterialName(name: string): string | null {
  const m = /^(#[0-9a-f]{6})(?:-\d+)?$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : null
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

export interface OrthoBounds {
  left: number
  right: number
  top: number
  bottom: number
  near: number
  far: number
}

/**
 * Orthographic shadow-camera bounds that just enclose a box, for a directional light at `lightPos` aimed at `target`
 * (Three.js's lookAt convention: camera -Z points along the light direction, +Y is as close to world up as possible).
 */
export function shadowBounds(min: V3, max: V3, lightPos: V3, target: V3, margin = 0.5): OrthoBounds {
  const z = norm(sub(lightPos, target)) // camera +Z points back toward the light
  const x = norm(cross([0, 1, 0], z))
  const y = cross(z, x)
  const b: OrthoBounds = { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity, near: Infinity, far: -Infinity }
  for (const cx of [min[0], max[0]]) for (const cy of [min[1], max[1]]) for (const cz of [min[2], max[2]]) {
    const p = sub([cx, cy, cz], lightPos)
    const [px, py, depth] = [dot(p, x), dot(p, y), -dot(p, z)]
    b.left = Math.min(b.left, px); b.right = Math.max(b.right, px)
    b.bottom = Math.min(b.bottom, py); b.top = Math.max(b.top, py)
    b.near = Math.min(b.near, depth); b.far = Math.max(b.far, depth)
  }
  return { left: b.left - margin, right: b.right + margin, top: b.top + margin, bottom: b.bottom - margin, near: Math.max(0.01, b.near - margin), far: b.far + margin }
}

/** A camera position around `focus`: azimuth measured from `facing` (a horizontal unit vector), elevation above the horizon. */
export function orbitPosition(focus: V3, facing: { x: number; z: number }, azimuthDeg: number, elevationDeg: number, distance: number): V3 {
  const a = (azimuthDeg * Math.PI) / 180
  const e = (elevationDeg * Math.PI) / 180
  // Rotate the facing direction about Y by the azimuth (positive turns toward +X for a +Z-facing wall).
  const dx = facing.x * Math.cos(a) + facing.z * Math.sin(a)
  const dz = -facing.x * Math.sin(a) + facing.z * Math.cos(a)
  return [focus[0] + dx * Math.cos(e) * distance, focus[1] + Math.sin(e) * distance, focus[2] + dz * Math.cos(e) * distance]
}
