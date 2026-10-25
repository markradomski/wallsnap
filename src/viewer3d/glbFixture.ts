/**
 * Test-only: builds small, valid, FloorGen-shaped GLB files in memory (one group per storey; walls / floors / furniture /
 * stairs meshes; one material per colour, named "#rrggbb-n"; non-indexed triangles with flat normals; Y up, metres).
 * It lets tests exercise the real loader and the viewer without any private model. Not imported by the app.
 */
import type { V3 } from './transform'

export interface FixtureSolid {
  /** Colour as #rrggbb. */
  color: string
  /** Eight corners, bottom face first (counter-clockwise from above), then the top face. Metres. */
  corners: V3[]
}

export interface FixtureFloor {
  name: string
  walls?: FixtureSolid[]
  floors?: FixtureSolid[]
  furniture?: FixtureSolid[]
  stairs?: FixtureSolid[]
}

/** An axis-aligned box. */
export function box(min: V3, max: V3, color: string): FixtureSolid {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  return { color, corners: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] }
}

/** A box of width (along local X) x height (Y) x depth (local Z), centred at (cx, cz) on the plan, rotated clockwise by `deg`
 *  in the plan like a FloorGen item. All plan values in cm; output in metres. */
export function orientedBox(cxCm: number, czCm: number, widthCm: number, depthCm: number, y0Cm: number, heightCm: number, deg: number, color: string): FixtureSolid {
  const t = (deg * Math.PI) / 180
  const w = widthCm / 2
  const d = depthCm / 2
  // Local axes in plan (x, y): width runs along (cos t, sin t), depth along (-sin t, cos t).
  const at = (lx: number, lz: number): [number, number] => [cxCm + lx * Math.cos(t) - lz * Math.sin(t), czCm + lx * Math.sin(t) + lz * Math.cos(t)]
  const ring = [at(-w, -d), at(w, -d), at(w, d), at(-w, d)]
  const m = (v: number) => v / 100
  return { color, corners: [...ring.map(([x, z]): V3 => [m(x), m(y0Cm), m(z)]), ...ring.map(([x, z]): V3 => [m(x), m(y0Cm + heightCm), m(z)])] }
}

const FACES: [number, number, number, number][] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]

function trianglesOf(solid: FixtureSolid): { pos: number[]; nrm: number[] } {
  const pos: number[] = []
  const nrm: number[] = []
  const c = solid.corners
  const centre = c.reduce((s, p) => [s[0] + p[0] / 8, s[1] + p[1] / 8, s[2] + p[2] / 8], [0, 0, 0])
  for (const [a, b, d, e] of FACES) {
    const u = [c[b][0] - c[a][0], c[b][1] - c[a][1], c[b][2] - c[a][2]]
    const v = [c[e][0] - c[a][0], c[e][1] - c[a][1], c[e][2] - c[a][2]]
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(...n) || 1
    n = n.map((x) => x / len)
    // Point outwards.
    const out = [c[a][0] - centre[0], c[a][1] - centre[1], c[a][2] - centre[2]]
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) n = n.map((x) => -x)
    for (const i of [a, b, d, a, d, e]) {
      pos.push(...c[i])
      nrm.push(...n)
    }
  }
  return { pos, nrm }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const hexToLinear = (hex: string): number[] => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)).concat(1)

export interface FixtureOptions {
  generator?: string
  floors: FixtureFloor[]
}

export function buildGlb({ floors, generator = 'FloorGen (https://floorgen.app)' }: FixtureOptions): Uint8Array {
  const materials: object[] = []
  const matIndex = new Map<string, number>()
  const matFor = (hex: string) => {
    if (!matIndex.has(hex)) {
      matIndex.set(hex, materials.length)
      materials.push({ name: `${hex}-${materials.length}`, pbrMetallicRoughness: { baseColorFactor: hexToLinear(hex), metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true })
    }
    return matIndex.get(hex)!
  }
  const chunks: Float32Array[] = []
  const bufferViews: object[] = []
  const accessors: object[] = []
  const meshes: object[] = []
  const nodes: object[] = []
  const roots: number[] = []
  let byteLength = 0
  const addAccessor = (data: number[], type: 'VEC3', withBounds: boolean) => {
    const f = new Float32Array(data)
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: f.byteLength })
    const acc: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: 5126, count: data.length / 3, type }
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], data[i + k]); max[k] = Math.max(max[k], data[i + k]) }
      acc.min = min
      acc.max = max
    }
    accessors.push(acc)
    chunks.push(f)
    byteLength += f.byteLength
    return accessors.length - 1
  }

  for (const fl of floors) {
    const children: number[] = []
    for (const cat of ['walls', 'floors', 'furniture', 'stairs'] as const) {
      const solids = fl[cat]
      if (!solids?.length) continue
      const byColour = new Map<string, FixtureSolid[]>()
      for (const s of solids) byColour.set(s.color, [...(byColour.get(s.color) ?? []), s])
      const primitives = [...byColour].map(([hex, group]) => {
        const pos: number[] = []
        const nrm: number[] = []
        for (const s of group) {
          const t = trianglesOf(s)
          pos.push(...t.pos)
          nrm.push(...t.nrm)
        }
        return { attributes: { POSITION: addAccessor(pos, 'VEC3', true), NORMAL: addAccessor(nrm, 'VEC3', false) }, material: matFor(hex) }
      })
      meshes.push({ name: `${fl.name} ${cat}`, primitives })
      nodes.push({ name: `${fl.name} ${cat}`, mesh: meshes.length - 1 })
      children.push(nodes.length - 1)
    }
    nodes.push({ name: fl.name, children })
    roots.push(nodes.length - 1)
  }

  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20)
  jsonPadded.set(jsonBytes)
  const bin = new Uint8Array(byteLength)
  let at = 0
  for (const c of chunks) {
    bin.set(new Uint8Array(c.buffer), at)
    at += c.byteLength
  }
  const out = new Uint8Array(12 + 8 + jsonPadded.length + 8 + bin.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, jsonPadded.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonPadded, 20)
  dv.setUint32(20 + jsonPadded.length, bin.length, true)
  dv.setUint32(24 + jsonPadded.length, 0x004e4942, true)
  out.set(bin, 28 + jsonPadded.length)
  return out
}

export interface GenericSpec {
  /** 0 = ground, 1 = first, 2 = second. */
  floor: number
  /** Plan centre and sizes in cm, elevation above that floor's base, rotation in degrees clockwise (as FloorGen stores them). */
  x: number
  y: number
  width: number
  height: number
  elevation: number
  rotation: number
  depth?: number
}

/**
 * A FloorGen-shaped townhouse around the mock project's geometry: three storeys of 250 cm, each a 100..x1 by 100..500 cm
 * room (walls 15 cm thick), a sofa-like block and a generic artwork solid (#4b5a70) for each entry of `generic`, exactly
 * where FloorGen would put it. Used by unit and browser tests; no private model is needed.
 */
export function mockTownhouse(opts: { generic?: GenericSpec[]; x1Cm?: number; extraStorey?: boolean } = {}): Uint8Array {
  const x1 = (opts.x1Cm ?? 700) / 100
  const wallColour = '#f5f2e9'
  const room = (base: number): FixtureSolid[] => [
    box([0.925, base, 0.925], [x1 + 0.075, base + 2.5, 1.075], wallColour), // north wall
    box([0.925, base, 4.925], [x1 + 0.075, base + 2.5, 5.075], wallColour), // south
    box([0.925, base, 0.925], [1.075, base + 2.5, 5.075], wallColour), // west
    box([x1 - 0.075, base, 0.925], [x1 + 0.075, base + 2.5, 5.075], wallColour), // east
  ]
  const slab = (base: number): FixtureSolid[] => [box([1.075, base, 1.075], [x1 - 0.075, base + 0.0005, 4.925], '#6f7a85')]
  const generics = (floor: number): FixtureSolid[] =>
    (opts.generic ?? []).filter((g) => g.floor === floor).map((g) => orientedBox(g.x, g.y, g.width, g.depth ?? 3, floor * 250 + g.elevation, g.height, g.rotation, '#4b5a70'))
  const floorOf = (i: number, name: string, extra: FixtureSolid[] = []): FixtureFloor => ({
    name,
    walls: room(i * 2.5),
    floors: slab(i * 2.5),
    furniture: [box([2.5, i * 2.5, 2.0], [4.5, i * 2.5 + 0.5, 3.0], '#2f6f70'), ...generics(i), ...extra],
  })
  const floors = [floorOf(0, 'Ground floor'), floorOf(1, 'First floor')]
  if (opts.extraStorey !== false) floors.push(floorOf(2, 'Second floor'))
  return buildGlb({ floors })
}
