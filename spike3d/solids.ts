import type { Aabb, V3 } from './transform'

/**
 * Splits non-indexed triangle vertex data (as the FloorGen GLB stores it) into separate solids: triangles that share
 * vertex positions belong to the same solid. Returns one axis-aligned box per solid, in the input's units.
 */
export function clusterSolids(positions: ArrayLike<number>, tolerance = 1e-5): Aabb[] {
  const count = Math.floor(positions.length / 3)
  const key = (i: number) =>
    [0, 1, 2].map((k) => Math.round(positions[i * 3 + k] / tolerance)).join(',')
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
  const boxes = new Map<string, Aabb>()
  for (let i = 0; i < count; i++) {
    const r = find(key(i))
    const v: V3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
    const b = boxes.get(r)
    if (!b) boxes.set(r, { min: [...v], max: [...v] })
    else for (let k = 0; k < 3; k++) {
      b.min[k] = Math.min(b.min[k], v[k])
      b.max[k] = Math.max(b.max[k], v[k])
    }
  }
  return [...boxes.values()]
}
