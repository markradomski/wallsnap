import type { Aabb, V3 } from './transform'

export interface Solid {
  /** Axis-aligned bounds, in the input's units. */
  box: Aabb
  /** Triangle numbers (vertex indices 3t..3t+2) that belong to this solid. */
  triangles: number[]
}

/**
 * Splits non-indexed triangle vertex data (as the FloorGen GLB stores it) into separate solids: triangles that share
 * vertex positions belong to the same solid. Deterministic: solids come out in order of their first triangle.
 */
export function clusterSolidTriangles(positions: ArrayLike<number>, tolerance = 1e-5): Solid[] {
  const count = Math.floor(positions.length / 3)
  const key = (i: number) => [0, 1, 2].map((k) => Math.round(positions[i * 3 + k] / tolerance)).join(',')
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k)
    let root = k
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(k, root)
    return root
  }
  for (let t = 0; t + 2 < count; t += 3) {
    const a = find(key(t))
    for (const k of [1, 2]) parent.set(find(key(t + k)), a)
  }
  const solids = new Map<string, Solid>()
  for (let t = 0; t + 2 < count; t += 3) {
    const r = find(key(t))
    let s = solids.get(r)
    if (!s) solids.set(r, (s = { box: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, triangles: [] }))
    s.triangles.push(t / 3)
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++) {
        const v = positions[(t + k) * 3 + c]
        s.box.min[c] = Math.min(s.box.min[c], v)
        s.box.max[c] = Math.max(s.box.max[c], v)
      }
    }
  }
  return [...solids.values()]
}

/** Bounds only (kept for callers that do not need the triangles). */
export function clusterSolids(positions: ArrayLike<number>, tolerance = 1e-5): Aabb[] {
  return clusterSolidTriangles(positions, tolerance).map((s) => s.box)
}

/** A copy of an attribute array without the given triangles (non-indexed, `stride` floats per vertex). */
export function withoutTriangles(data: ArrayLike<number>, stride: number, triangles: ReadonlySet<number>): Float32Array {
  const perTriangle = stride * 3
  const total = Math.floor(data.length / perTriangle)
  const out = new Float32Array((total - [...triangles].filter((t) => t >= 0 && t < total).length) * perTriangle)
  let at = 0
  for (let t = 0; t < total; t++) {
    if (triangles.has(t)) continue
    for (let i = 0; i < perTriangle; i++) out[at++] = data[t * perTriangle + i]
  }
  return out
}

export type { V3 }
