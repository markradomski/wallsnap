import { beforeEach, describe, expect, it } from 'vitest'
import { StaleError, ValidationError, WallSnapAdapter } from './adapter'
import { Recorder } from './helpers.test-util'
import { MockGateway } from './mock'
import { guardWrites } from './safety'

let mock: MockGateway
let rec: Recorder
let adapter: WallSnapAdapter
beforeEach(() => {
  mock = new MockGateway()
  rec = new Recorder(mock)
  adapter = new WallSnapAdapter(guardWrites(rec, 'mock-project'), 'mock-project')
})

const art = { width: 60, height: 45, u: 300, v: 120 }

describe('WallSnapAdapter (mock gateway, synthetic geometry)', () => {
  it('marks the long ground-floor wall reserved and nothing else', async () => {
    const floors = await adapter.listFloors()
    const reserved = floors.flatMap((f) => f.walls).filter((w) => w.reserved)
    expect(reserved.map((w) => w.id)).toEqual(['gs_north'])
  })

  it('refuses to load the reserved wall', async () => {
    await expect(adapter.loadWall('f_ground', 'gs_north')).rejects.toThrow(/reserved/)
  })

  it('creates then reuses one artwork, confirmed by read-back', async () => {
    const s = await adapter.loadWall('f_first', 'fl_north')
    expect(s.artwork).toBeNull()
    const first = await adapter.apply('f_first', 'fl_north', art, s.rev)
    expect(first.created).toBe(true)
    expect(first.artwork).toMatchObject(art)
    const again = await adapter.apply('f_first', 'fl_north', { ...art, u: 400 }, first.rev)
    expect(again.created).toBe(false)
    expect(again.artwork.u).toBeCloseTo(400)
    expect(rec.calls.filter((c) => c.tool === 'place_on_wall' && c.args.catalog_id)).toHaveLength(1)
  })

  it('measures u from endpoint A on a wall stored in the opposite direction', async () => {
    // fl_south runs A(700,500) -> B(100,500); u = 300 is x = 400 in the plan, facing north (rotation 180).
    const s = await adapter.loadWall('f_first', 'fl_south')
    const r = await adapter.apply('f_first', 'fl_south', { ...art, u: 300 }, s.rev)
    expect(r.artwork.u).toBeCloseTo(300)
    const moves = rec.calls.filter((c) => c.tool === 'place_on_wall')
    expect(moves.at(-1)!.args).toMatchObject({ wall_id: 'fl_south', offset: 300, elevation: 120 })
    const item = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: { x: number; y: number; rotation: number }[] }
    expect(item.rows[0]).toMatchObject({ x: 400, y: 500 - 7.5 - 1.5, rotation: 180 })
  })

  it('keeps the same u meaning on a wall running the other way', async () => {
    const n = await adapter.loadWall('f_first', 'fl_north') // A(100,100) -> B(700,100)
    await adapter.apply('f_first', 'fl_north', { ...art, u: 100 }, n.rev)
    const item = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: { x: number; y: number }[] }
    expect(item.rows[0]).toMatchObject({ x: 200, y: 100 + 7.5 + 1.5 })
  })

  it('hangs near a wall end by resizing first, then moving to the exact u', async () => {
    const s = await adapter.loadWall('f_first', 'fl_north')
    const r = await adapter.apply('f_first', 'fl_north', { width: 40, height: 30, u: 25, v: 150 }, s.rev)
    expect(r.artwork.u).toBeCloseTo(25)
    const moves = rec.calls.filter((c) => c.tool === 'place_on_wall')
    expect(moves.map((c) => c.args.offset)).toEqual([50, 25])
  })

  it('places openings by u as well', async () => {
    const north = await adapter.loadWall('f_first', 'fl_north')
    expect(north.wall.openings[0]).toMatchObject({ left: 140, width: 120 }) // offset 200 from A, centred
    await expect(
      adapter.apply('f_first', 'fl_north', { ...art, u: 200, v: 100 }, north.rev),
    ).rejects.toThrow(/door or window/)
  })

  it('rejects stale revisions instead of overwriting', async () => {
    const s = await adapter.loadWall('f_first', 'fl_north')
    mock.touch()
    await expect(adapter.apply('f_first', 'fl_north', art, s.rev)).rejects.toBeInstanceOf(StaleError)
    expect(rec.writes()).toHaveLength(0)
  })

  it('rejects invalid placements before writing', async () => {
    const s = await adapter.loadWall('f_first', 'fl_north')
    await expect(adapter.apply('f_first', 'fl_north', { ...art, height: 250 }, s.rev)).rejects.toBeInstanceOf(ValidationError)
    await expect(adapter.apply('f_first', 'fl_north', { ...art, u: 10 }, s.rev)).rejects.toBeInstanceOf(ValidationError)
    expect(rec.writes()).toHaveLength(0)
  })
})

describe('slanted wall', () => {
  it('hangs flush on a non-axis-aligned wall and reads back the same u', async () => {
    // gs_east: A(800,100) -> B(700,500); it is not reserved (only ~412 cm long), so it can be loaded.
    const s = await adapter.loadWall('f_ground', 'gs_east')
    const r = await adapter.apply('f_ground', 'gs_east', { width: 50, height: 40, u: 200, v: 100 }, s.rev)
    expect(r.artwork).toMatchObject({ width: 50, height: 40, v: 100 })
    expect(r.artwork.u).toBeCloseTo(200, 1)
  })
})

describe('regression: resizing an item that is currently too tall for its new elevation', () => {
  it('resizes before moving, so FloorGen never sees the old size at the new elevation', async () => {
    // fl_east is 400 x 250. Start with a 165 x 165 artwork low on the wall (as left by an earlier save).
    const s0 = await adapter.loadWall('f_first', 'fl_east')
    const big = await adapter.apply('f_first', 'fl_east', { width: 165, height: 165, u: 110.6, v: 35.2 }, s0.rev)
    // Reported failure: 113.8 x 71.4 at u 116.6, v 117.6. 117.6 + 165 = 282.6 > 250 with the old size.
    const next = { width: 113.8, height: 71.4, u: 116.6, v: 117.6 }
    const r = await adapter.apply('f_first', 'fl_east', next, big.rev)
    expect(r.created).toBe(false)
    expect(r.artwork.width).toBeCloseTo(113.8)
    expect(r.artwork.height).toBeCloseTo(71.4)
    expect(r.artwork.u).toBeCloseTo(116.6)
    expect(r.artwork.v).toBeCloseTo(117.6)
  })

  it('updates the same object: no duplicate is created', async () => {
    const s0 = await adapter.loadWall('f_first', 'fl_east')
    const big = await adapter.apply('f_first', 'fl_east', { width: 165, height: 165, u: 110.6, v: 35.2 }, s0.rev)
    await adapter.apply('f_first', 'fl_east', { width: 113.8, height: 71.4, u: 116.6, v: 117.6 }, big.rev)
    const items = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: unknown[] }
    expect(items.rows).toHaveLength(1)
    expect(rec.calls.filter((c) => c.tool === 'place_on_wall' && c.args.catalog_id)).toHaveLength(1)
  })

  it('sizes before the final move, in that order', async () => {
    const s0 = await adapter.loadWall('f_first', 'fl_east')
    const big = await adapter.apply('f_first', 'fl_east', { width: 165, height: 165, u: 110.6, v: 35.2 }, s0.rev)
    rec.calls.length = 0
    await adapter.apply('f_first', 'fl_east', { width: 113.8, height: 71.4, u: 116.6, v: 117.6 }, big.rev)
    expect(rec.writes().map((c) => c.tool)).toEqual(['update_items', 'place_on_wall'])
  })

  it('creating a tall-positioned small artwork also works (new picture is 100 x 70 until resized)', async () => {
    const s = await adapter.loadWall('f_first', 'fl_east')
    // v 200 + the catalogue's 70 cm would exceed 250; u 20 + 50 would overhang the wall start.
    const r = await adapter.apply('f_first', 'fl_east', { width: 40, height: 40, u: 20, v: 200 }, s.rev)
    expect(r.created).toBe(true)
    expect(r.artwork).toMatchObject({ width: 40, height: 40 })
    expect(r.artwork.u).toBeCloseTo(20)
    expect(r.artwork.v).toBeCloseTo(200)
  })
})
