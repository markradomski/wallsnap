/**
 * What a GLB file declares, read from its JSON chunk alone (no geometry is decoded and nothing is executed): per floor,
 * how many meshes and triangles it holds and the bounds of its vertices. The viewer compares this with what actually ends
 * up in its scene, so a floor that was dropped, hidden, shifted or rescaled cannot go unnoticed.
 */
export interface GltfJson {
  asset?: { generator?: string }
  scene?: number
  scenes: { nodes: number[] }[]
  nodes: { name?: string; mesh?: number; children?: number[] }[]
  meshes: { name?: string; primitives: { attributes: { POSITION: number }; indices?: number; mode?: number }[] }[]
  accessors: { count: number; min?: number[]; max?: number[] }[]
}

export function readGlbJson(bytes: Uint8Array): GltfJson {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file (bad magic).')
  if (dv.getUint32(4, true) !== 2) throw new Error('Unsupported glTF version.')
  const len = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > bytes.byteLength) throw new Error('GLB has no JSON chunk.')
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as GltfJson
}

export type FloorKey = 'ground' | 'first' | 'second'

/** Which storey a node is, from its name. glTF loaders sanitise names (spaces become underscores), so accept both. */
export function floorKey(name: string): FloorKey | null {
  const m = /^(ground|first|second)[ _]floor/i.exec(name)
  return m ? (m[1].toLowerCase() as FloorKey) : null
}

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface FloorInfo {
  name: string
  key: FloorKey | null
  /** Renderable primitives (each becomes one mesh in a loader). */
  meshes: number
  triangles: number
  bounds: Bounds | null
  categories: { name: string; triangles: number }[]
}

/** One entry per top-level node of the default scene (FloorGen exports one group per storey). */
export function describeFloors(g: GltfJson): FloorInfo[] {
  const roots = g.scenes[g.scene ?? 0]?.nodes ?? []
  return roots.map((r) => {
    const node = g.nodes[r]
    const name = node.name ?? `node ${r}`
    const info: FloorInfo = { name, key: floorKey(name), meshes: 0, triangles: 0, bounds: null, categories: [] }
    const visit = (i: number, label: string) => {
      const n = g.nodes[i]
      if (n.mesh !== undefined) {
        let tris = 0
        for (const p of g.meshes[n.mesh].primitives) {
          if ((p.mode ?? 4) !== 4) continue // FloorGen exports triangle lists only
          const pos = g.accessors[p.attributes.POSITION]
          tris += (p.indices !== undefined ? g.accessors[p.indices].count : pos.count) / 3
          info.meshes++
          if (pos.min && pos.max) {
            info.bounds ??= { min: [...pos.min] as Bounds['min'], max: [...pos.max] as Bounds['max'] }
            for (let k = 0; k < 3; k++) {
              info.bounds.min[k] = Math.min(info.bounds.min[k], pos.min[k])
              info.bounds.max[k] = Math.max(info.bounds.max[k], pos.max[k])
            }
          }
        }
        info.triangles += tris
        info.categories.push({ name: label.replace(name, '').trim() || label, triangles: tris })
      }
      for (const c of n.children ?? []) visit(c, g.nodes[c].name ?? '')
    }
    visit(r, name)
    return info
  })
}
