import { describe, expect, it } from 'vitest'
import { describeFloors, floorKey, readGlbJson, type GltfJson } from './glbInfo'

/** A tiny but real GLB container around a JSON document (geometry is not needed: only the declarations are read). */
function glb(json: object): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20)
  padded.set(text)
  const out = new Uint8Array(20 + padded.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, out.length, true)
  dv.setUint32(12, padded.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(padded, 20)
  return out
}

/** Three storeys, FloorGen-style: one group per floor, one node and mesh per category. The second has no stairs. */
const gltf = (): GltfJson => {
  const accessors: GltfJson['accessors'] = []
  const meshes: GltfJson['meshes'] = []
  const nodes: GltfJson['nodes'] = []
  const floors = [
    { name: 'Ground Floor — Art Studio', y: [0, 2.2], cats: { walls: 24, stairs: 12 } },
    { name: 'First Floor — Living', y: [2.2, 4.4], cats: { walls: 30, furniture: 12 } },
    { name: 'Second Floor — Bedrooms', y: [4.4, 6.6], cats: { walls: 18, furniture: 6 } },
  ]
  const roots: number[] = []
  for (const f of floors) {
    const children: number[] = []
    for (const [cat, tris] of Object.entries(f.cats)) {
      accessors.push({ count: tris * 3, min: [1.4, f.y[0], 4.7], max: [8.5, f.y[1], 9.3] })
      meshes.push({ name: `${f.name} ${cat}`, primitives: [{ attributes: { POSITION: accessors.length - 1 } }] })
      nodes.push({ name: `${f.name} ${cat}`, mesh: meshes.length - 1 })
      children.push(nodes.length - 1)
    }
    nodes.push({ name: f.name, children })
    roots.push(nodes.length - 1)
  }
  return { scenes: [{ nodes: roots }], nodes, meshes, accessors }
}

describe('readGlbJson', () => {
  it('reads the JSON chunk of a GLB', () => {
    expect(readGlbJson(glb(gltf())).scenes[0].nodes).toHaveLength(3)
  })
  it('rejects anything that is not a GLB, or is truncated', () => {
    expect(() => readGlbJson(new TextEncoder().encode('{"not":"a glb file at all, really"}'))).toThrow(/bad magic/)
    expect(() => readGlbJson(new Uint8Array(4))).toThrow(/bad magic/)
    const ok = glb(gltf())
    expect(() => readGlbJson(ok.subarray(0, 40))).toThrow(/no JSON chunk/)
    const v1 = glb(gltf())
    new DataView(v1.buffer).setUint32(4, 1, true)
    expect(() => readGlbJson(v1)).toThrow(/version/)
  })
})

describe('floorKey', () => {
  it.each([
    ['Ground Floor — Art Studio / Laundry', 'ground'],
    ['First Floor — Living / Dining / Kitchen', 'first'],
    ['Second Floor — Bedrooms / Bathroom', 'second'],
    // three.js GLTFLoader sanitises node names: spaces become underscores and some punctuation disappears
    ['Ground_Floor__Art_Studio__Laundry', 'ground'],
    ['First_Floor__Living__Dining__Kitchen', 'first'],
    ['Second_Floor__Bedrooms__Bathroom', 'second'],
    ['second floor', 'second'],
  ])('%s -> %s', (name, key) => expect(floorKey(name)).toBe(key))
  it('does not mistake other nodes for storeys', () => {
    for (const n of ['The First Floor', 'Floorplan', 'Third Floor', 'wallsnap-artwork', '']) expect(floorKey(n)).toBeNull()
  })
})

describe('describeFloors', () => {
  const floors = describeFloors(readGlbJson(glb(gltf())))
  it('reports every storey with its renderable triangles', () => {
    expect(floors.map((f) => [f.key, f.meshes, f.triangles])).toEqual([['ground', 2, 36], ['first', 2, 42], ['second', 2, 24]])
  })
  it('lists categories (a floor without stairs simply has none)', () => {
    expect(floors[0].categories.map((c) => c.name)).toEqual(['walls', 'stairs'])
    expect(floors[2].categories.map((c) => c.name)).toEqual(['walls', 'furniture'])
  })
  it('reports stacked, non-overlapping vertical bounds per floor', () => {
    expect(floors.map((f) => [f.bounds!.min[1], f.bounds!.max[1]])).toEqual([[0, 2.2], [2.2, 4.4], [4.4, 6.6]])
  })
  it('counts indexed geometry by its indices', () => {
    const g = gltf()
    g.accessors.push({ count: 99 }, { count: 30 })
    g.meshes[0].primitives[0] = { attributes: { POSITION: 0 }, indices: g.accessors.length - 1 }
    expect(describeFloors(g)[0].triangles).toBe(10 + 12) // 30 indices -> 10 triangles, plus the stairs
  })
  it('ignores non-triangle primitives', () => {
    const g = gltf()
    g.meshes[0].primitives[0].mode = 1 // lines
    expect(describeFloors(g)[0].triangles).toBe(12)
  })
})
