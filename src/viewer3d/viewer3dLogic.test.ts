import { describe, expect, it } from 'vitest'
import { facingRotation, flushPerp, wallFrame, type Pt } from '../geometry'
import type { PlanContext } from '../types'
import { box, buildGlb, mockTownhouse } from './glbFixture'
import { groupIndexFor, hasUpperFloors, normName, visibleGroups } from './floors'
import { MAX_MODEL_BYTES, checkModelBytes, wallFitsModel } from './modelCheck'
import { createModelStore, modelKey } from './modelStore'
import { frameOf, localPlanItem, savedPlanItem } from './plan'
import { frontDirection, placementFor, planToWorld } from './transform'
import type { KV } from '../imageStore'

const planFor = (a: Pt, b: Pt, over: Partial<PlanContext> = {}): PlanContext => {
  const n = wallFrame(a, b, { x: 400, y: 300 }).normal
  return {
    rev: 1, floors: [{ id: 'g', name: 'Ground', height: 250 }, { id: 'f', name: 'First', height: 250 }], floorId: 'f', baseCm: 250,
    wall: { id: 'w', a, b, length: Math.hypot(b.x - a.x, b.y - a.y), height: 250, thickness: 15, normal: n }, item: null, ...over,
  }
}

describe('localPlanItem: unsaved WallSnap edits as plan coordinates', () => {
  const walls: [string, Pt, Pt][] = [
    ['north', { x: 100, y: 100 }, { x: 700, y: 100 }],
    ['south (reversed)', { x: 700, y: 500 }, { x: 100, y: 500 }],
    ['west', { x: 100, y: 100 }, { x: 100, y: 500 }],
    ['east', { x: 700, y: 100 }, { x: 700, y: 500 }],
    ['slanted', { x: 100, y: 500 }, { x: 600, y: 200 }],
  ]
  it.each(walls)('%s wall: u counts from endpoint A, flush on the room face, facing the room', (_n, a, b) => {
    const plan = planFor(a, b)
    const art = { width: 80, height: 50, u: 150, v: 110 }
    const it = localPlanItem(plan, art)
    const f = frameOf(plan.wall)
    // Distance along the wall from A is exactly u, and the offset from the wall line is the flush distance.
    const dx = it.x - a.x, dy = it.y - a.y
    expect(dx * f.dir.x + dy * f.dir.y).toBeCloseTo(150, 9)
    expect(dx * f.normal.x + dy * f.normal.y).toBeCloseTo(flushPerp(15, 3), 9)
    expect(it).toMatchObject({ width: 80, height: 50, elevation: 110, depth: 3 })
    // The 3D plane faces the room: its world normal is the wall's room-facing normal.
    const place = placementFor(it, plan.baseCm)
    expect(place.normal[0]).toBeCloseTo(plan.wall.normal.x, 4)
    expect(place.normal[2]).toBeCloseTo(plan.wall.normal.y, 4)
    const front = frontDirection(it.rotation)
    expect([front.x, front.z]).toEqual([expect.closeTo(plan.wall.normal.x, 4), expect.closeTo(plan.wall.normal.y, 4)])
    // And its world position uses the verified conversion (metres, floor base added to elevation).
    expect(place.position[1]).toBeCloseTo((250 + 110 + 25) * 0.01, 9)
  })

  it('uses FloorGen\'s own depth for an existing artwork and a default for a new one', () => {
    const p = planFor({ x: 100, y: 100 }, { x: 700, y: 100 })
    expect(localPlanItem(p, { width: 10, height: 10, u: 50, v: 0 }).depth).toBe(3)
    const withItem = planFor({ x: 100, y: 100 }, { x: 700, y: 100 }, { item: { id: 'i', x: 0, y: 0, rotation: 0, width: 1, height: 1, depth: 5, elevation: 0, color: '#4b5a70' } })
    expect(localPlanItem(withItem, { width: 10, height: 10, u: 50, v: 0 }).depth).toBe(5)
  })

  it('moves with the edit: another u or v gives another place, never a cached one', () => {
    const p = planFor({ x: 100, y: 100 }, { x: 700, y: 100 })
    const a = localPlanItem(p, { width: 60, height: 40, u: 100, v: 100 })
    const b = localPlanItem(p, { width: 60, height: 40, u: 250, v: 140 })
    expect(b.x - a.x).toBeCloseTo(150, 9)
    expect(b.elevation - a.elevation).toBe(40)
  })

  it('the savedPlanItem is exactly what the server reported', () => {
    expect(savedPlanItem(planFor({ x: 0, y: 0 }, { x: 100, y: 0 }))).toBeNull()
    const item = { id: 'i', x: 1, y: 2, rotation: 90, width: 3, height: 4, depth: 3, elevation: 5, color: '#4b5a70' }
    expect(savedPlanItem(planFor({ x: 0, y: 0 }, { x: 100, y: 0 }, { item }))).toEqual({ x: 1, y: 2, rotation: 90, width: 3, height: 4, depth: 3, elevation: 5 })
  })

  it('plan-to-world: no hardcoded floor base, whatever the storey heights', () => {
    for (const base of [0, 250, 480]) expect(planToWorld(500, 300, 100, base)).toEqual([5, (base + 100) / 100, 3])
    expect(facingRotation({ x: 0, y: 1 })).toBe(0)
  })
})

describe('floor groups and visibility', () => {
  const floors = [{ id: 'g', name: 'Ground Floor — Art Studio / Laundry' }, { id: 'f1', name: 'First Floor — Living / Dining / Kitchen' }, { id: 'f2', name: 'Second Floor — Bedrooms' }]
  const names = floors.map((f) => f.name)
  it('matches by name, also for loader-sanitised names, regardless of order', () => {
    expect(groupIndexFor(names, floors, 'f1')).toBe(1)
    expect(groupIndexFor(['Ground_Floor__Art_Studio__Laundry', 'First_Floor__Living__Dining__Kitchen', 'Second_Floor__Bedrooms'], floors, 'f2')).toBe(2)
    expect(groupIndexFor([...names].reverse(), floors, 'g')).toBe(2)
    expect(normName('First Floor — Living')).toBe('firstfloorliving')
  })
  it('falls back to storey order when the model uses entirely different names, and gives up when it cannot map', () => {
    expect(groupIndexFor(['Level 0', 'Level 1', 'Level 2'], floors, 'f1')).toBe(1)
    expect(groupIndexFor(['Level 0'], floors, 'f2')).toBeNull()
    expect(groupIndexFor(names, floors, 'unknown')).toBeNull()
    // A partially renamed model is not guessed at.
    expect(groupIndexFor([names[0], 'Mezzanine', names[2]], floors, 'f1')).toBeNull()
  })
  it('inspect shows the selected storey and everything below; all shows everything', () => {
    expect(visibleGroups(3, 1, 'inspect')).toEqual([true, true, false])
    expect(visibleGroups(3, 0, 'inspect')).toEqual([true, false, false])
    expect(visibleGroups(3, 2, 'inspect')).toEqual([true, true, true])
    expect(visibleGroups(3, 1, 'all')).toEqual([true, true, true])
    expect(visibleGroups(3, null, 'inspect')).toEqual([true, true, true]) // unknown selection: hide nothing
    expect(hasUpperFloors(3, 1)).toBe(true)
    expect(hasUpperFloors(3, 2)).toBe(false)
    expect(hasUpperFloors(3, null)).toBe(false)
  })
})

describe('checkModelBytes: validating an imported model', () => {
  it('accepts a FloorGen-shaped building and reports what it holds', () => {
    const r = checkModelBytes(mockTownhouse())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.info.floors.map((f) => f.name)).toEqual(['Ground floor', 'First floor', 'Second floor'])
    expect(r.info.triangles).toBeGreaterThan(100)
    expect(r.info.bounds.min[1]).toBeCloseTo(0, 6)
    expect(r.info.bounds.max[1]).toBeCloseTo(7.5, 6)
    expect(r.warnings).toEqual([])
  })

  it.each([
    ['an empty file', new Uint8Array(0), /empty/],
    ['text that is not a GLB', new TextEncoder().encode('{"hello": "world"} and some more text'), /not a readable GLB/],
    ['a truncated GLB', mockTownhouse().subarray(0, 40), /not a readable GLB/],
    ['random bytes', Uint8Array.from({ length: 200 }, (_, i) => (i * 37) % 251), /not a readable GLB/],
  ])('rejects %s with an actionable message', (_n, bytes, msg) => {
    const r = checkModelBytes(bytes)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(msg)
    expect(!r.ok && r.error).toMatch(/export|FloorGen|empty/i)
  })

  it('rejects a GLB with no geometry', () => {
    const r = checkModelBytes(buildGlb({ floors: [{ name: 'Ground floor' }] }))
    expect(!r.ok && r.error).toMatch(/no usable building geometry/)
  })

  it('rejects a model that is not a FloorGen building (no walls)', () => {
    const r = checkModelBytes(buildGlb({ floors: [{ name: 'Props', furniture: [box([0, 0, 0], [3, 1, 3], '#ff0000')] }] }))
    expect(!r.ok && r.error).toMatch(/does not look like a FloorGen building export/)
  })

  it('rejects an implausible size (units or orientation are not FloorGen\'s: a building in millimetres)', () => {
    const mm = (v: number) => v * 1000
    const r = checkModelBytes(buildGlb({ floors: [{ name: 'Ground floor', walls: [box([0, 0, 0], [mm(8), mm(2.5), mm(5)], '#f5f2e9')] }] }))
    expect(!r.ok && r.error).toMatch(/not a plausible building in metres with Y up/)
    const tiny = checkModelBytes(buildGlb({ floors: [{ name: 'Ground floor', walls: [box([0, 0, 0], [0.05, 0.05, 0.05], '#f5f2e9')] }] }))
    expect(tiny.ok).toBe(false)
  })

  it('warns, but still accepts, a model that FloorGen did not write or that floats above the ground', () => {
    const floating = buildGlb({ generator: 'Blender 4.1', floors: [{ name: 'Ground floor', walls: [box([0, 3, 0], [8, 5.5, 5], '#f5f2e9')] }] })
    const r = checkModelBytes(floating)
    expect(r.ok).toBe(true)
    expect(r.ok && r.warnings.join(' ')).toMatch(/not written by FloorGen/)
    expect(r.ok && r.warnings.join(' ')).toMatch(/ground level/)
  })

  it('has a size limit', () => {
    expect(MAX_MODEL_BYTES).toBe(100 * 1024 * 1024)
    expect(checkModelBytes(new Uint8Array(MAX_MODEL_BYTES + 1)).ok).toBe(false)
  })
})

describe('wallFitsModel', () => {
  const info = checkModelBytes(mockTownhouse())
  const bounds = info.ok ? info.info.bounds : (undefined as never)
  it('accepts a wall inside the model and rejects a stale or foreign one', () => {
    expect(wallFitsModel(bounds, { x: 100, y: 100 }, { x: 700, y: 100 })).toBeNull()
    expect(wallFitsModel(bounds, { x: 1500, y: 100 }, { x: 2100, y: 100 })).toMatch(/outside this 3D model/)
    expect(wallFitsModel(bounds, { x: 100, y: 100 }, { x: 100, y: 5000 })).toMatch(/outside/)
  })
})

describe('model store', () => {
  const memory = (): { kv: KV; map: Map<string, unknown> } => {
    const map = new Map<string, unknown>()
    return { map, kv: { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), del: async (k) => void map.delete(k) } }
  }
  const model = { blob: new Blob([new Uint8Array([1, 2, 3])]), name: 'townhouse.glb', size: 3, summary: { floors: 3, triangles: 1380, generator: 'FloorGen' } }
  it('round-trips a model per project and replaces it on re-import', async () => {
    const m = memory()
    const store = createModelStore(m.kv)
    expect(await store.get('p_dev')).toEqual({ ok: true, value: null })
    expect((await store.put('p_dev', { ...model, importedAt: 1000 })).ok).toBe(true)
    expect(await store.get('p_dev')).toMatchObject({ ok: true, value: { name: 'townhouse.glb', importedAt: 1000 } })
    await store.put('p_dev', { ...model, name: 'new.glb', importedAt: 2000 })
    expect(await store.get('p_dev')).toMatchObject({ value: { name: 'new.glb', importedAt: 2000 } })
    expect((await store.get('p_other')).ok && (await store.get('p_other') as { value: unknown }).value).toBeNull() // per project
    expect(m.map.has(modelKey('p_dev'))).toBe(true)
  })
  it('reports damaged records and unavailable storage instead of throwing', async () => {
    const m = memory()
    m.map.set(modelKey('p'), { blob: 'not a blob', name: 'x', size: 1, importedAt: 1, summary: { floors: 1, triangles: 1 } })
    expect(await createModelStore(m.kv).get('p')).toEqual({ ok: false, reason: 'corrupt' })
    const broken: KV = { get: () => Promise.reject(new Error('blocked')), put: () => Promise.reject(new Error('blocked')), del: () => Promise.reject(new Error('blocked')) }
    expect(await createModelStore(broken).get('p')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await createModelStore(broken).put('p', model)).toEqual({ ok: false, reason: 'unavailable' })
    const full: KV = { ...broken, put: () => Promise.reject(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })) }
    expect(await createModelStore(full).put('p', model)).toEqual({ ok: false, reason: 'full' })
  })
})
