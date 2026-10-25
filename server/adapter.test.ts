import { beforeEach, describe, expect, it } from 'vitest'
import { MissingError, PartialWriteError, StaleError, ValidationError, WallSnapAdapter } from './adapter'
import { flushPerp, planPoint, wallFrame, type Pt } from '../src/geometry'
import { ENTITIES } from './fixture'
import { GatewayError, type Gateway } from './gateway'
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

describe('partial writes are described honestly', () => {
  /** Lets the first n place_on_wall calls through, then fails the rest. */
  const failingAfter = (n: number): Gateway => {
    let placed = 0
    return {
      kind: 'mock',
      call: (tool, args) => {
        if (tool === 'place_on_wall' && ++placed > n) {
          return Promise.reject(new GatewayError('The item would overlap something.', tool, 'VALIDATION_FAILED'))
        }
        return mock.call(tool, args)
      },
    }
  }

  it('an existing artwork that was resized but not moved says so', async () => {
    const s0 = await adapter.loadWall('f_first', 'fl_east')
    const first = await adapter.apply('f_first', 'fl_east', { width: 60, height: 40, u: 100, v: 100 }, s0.rev)
    const flaky = new WallSnapAdapter(failingAfter(0), 'mock-project')
    const err = await flaky.apply('f_first', 'fl_east', { width: 90, height: 50, u: 200, v: 100 }, first.rev).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PartialWriteError)
    expect((err as Error).message).toMatch(/resized to 90×50 cm/)
    expect((err as Error).message).toMatch(/moving it to the requested position failed \(The item would overlap/)
    // FloorGen really does hold the new size at the old position.
    const now = await adapter.loadWall('f_first', 'fl_east')
    expect(now.artwork).toMatchObject({ width: 90, height: 50 })
    expect(now.artwork!.u).toBeCloseTo(100)
  })

  it('a failure before anything was saved is reported as a plain error, not a partial save', async () => {
    const s = await adapter.loadWall('f_first', 'fl_east')
    const err = await new WallSnapAdapter(failingAfter(0), 'mock-project')
      .apply('f_first', 'fl_east', { width: 60, height: 40, u: 100, v: 100 }, s.rev).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).not.toBeInstanceOf(PartialWriteError)
  })
})

describe('Reload from FloorGen: reading the saved artwork back by its item id', () => {
  /** A wall with a saved artwork, then edits made "directly in FloorGen" through the mock hooks. */
  const saved = async (wall = 'fl_east', art = { width: 60, height: 40, u: 100, v: 100 }) => {
    const s0 = await adapter.loadWall('f_first', wall)
    const r = await adapter.apply('f_first', wall, art, s0.rev)
    return { id: r.artworkId, rev: r.rev, wall }
  }
  const frameOf = (wall: string) => {
    const w = ENTITIES.f_first.find((e) => e.id === wall) as { a: Pt; b: Pt }
    return wallFrame(w.a, w.b, { x: 400, y: 300 })
  }

  it('knows the artwork id after loading and after applying', async () => {
    const { id, wall } = await saved()
    expect(id).toMatch(/^i_/)
    expect((await adapter.loadWall('f_first', wall)).artworkId).toBe(id)
  })

  it('shows an external move: new u and v, the same id, and the new revision', async () => {
    const { id, wall, rev } = await saved()
    const f = frameOf(wall)
    const p = planPoint(f, 250, flushPerp(15, 3))
    mock.moveItem(id, { x: p.x, y: p.y })
    mock.resizeItem(id, { elevation: 150 })
    const s = await adapter.loadWall('f_first', wall, id)
    expect(s.detached).toBeNull()
    expect(s.artworkId).toBe(id)
    expect(s.artwork).toMatchObject({ width: 60, height: 40, v: 150 })
    expect(s.artwork!.u).toBeCloseTo(250, 6)
    expect(s.rev).toBeGreaterThan(rev)
  })

  it('shows an external resize', async () => {
    const { id, wall } = await saved()
    mock.resizeItem(id, { width: 90, height: 55 })
    expect((await adapter.loadWall('f_first', wall, id)).artwork).toMatchObject({ width: 90, height: 55, v: 100 })
  })

  it('measures u from endpoint A on a reversed wall (fl_south runs east to west)', async () => {
    const { id, wall } = await saved('fl_south', { width: 40, height: 40, u: 300, v: 120 })
    const f = frameOf(wall)
    expect(f.a.x).toBe(700) // endpoint A is the east end
    const p = planPoint(f, 90, flushPerp(15, 3)) // 90 cm from A, which is x = 610
    expect(p.x).toBeCloseTo(610, 6)
    mock.moveItem(id, { x: p.x, y: p.y })
    expect((await adapter.loadWall('f_first', wall, id)).artwork!.u).toBeCloseTo(90, 6)
  })

  it('agrees with the artwork shown by the plain wall load (one conversion, not two)', async () => {
    const { id, wall } = await saved()
    expect((await adapter.loadWall('f_first', wall, id)).artwork).toEqual((await adapter.loadWall('f_first', wall)).artwork)
  })

  it('performs no writes and never creates, resizes or moves anything', async () => {
    const { id, wall } = await saved()
    mock.resizeItem(id, { width: 70 })
    rec.calls.length = 0
    await adapter.loadWall('f_first', wall, id)
    expect(rec.writes()).toEqual([])
    expect(rec.calls.length).toBeGreaterThan(0)
    expect(rec.calls.every((c) => ['list_floors', 'list_entities'].includes(c.tool))).toBe(true)
  })

  describe('artwork no longer on the wall', () => {
    it('moved away from the wall: reports it and returns no coordinates', async () => {
      const { id, wall } = await saved()
      mock.moveItem(id, { x: 300 }) // fl_east is vertical: x is across the wall, so this drags it into the room
      const s = await adapter.loadWall('f_first', wall, id)
      expect(s.artwork).toBeNull() // no manufactured wall-relative position
      expect(s.artworkId).toBe(id)
      expect(s.detached?.message).toBe('Artwork is no longer positioned on this wall.')
      expect(s.detached?.reasons.join(' ')).toMatch(/wall surface/)
      expect(s.detached).toMatchObject({ width: 60, height: 40, elevation: 100 })
    })

    it('rotated away from facing the room', async () => {
      const { id, wall } = await saved()
      mock.moveItem(id, { rotation: 0 }) // an east wall faces west: correct rotation is 90
      const s = await adapter.loadWall('f_first', wall, id)
      expect(s.artwork).toBeNull()
      expect(s.detached?.reasons.join(' ')).toMatch(/turned 90° away/)
    })

    it('moved beyond the ends of the wall', async () => {
      const { id, wall } = await saved()
      const p = planPoint(frameOf(wall), 900, flushPerp(15, 3))
      mock.moveItem(id, { x: p.x, y: p.y })
      expect((await adapter.loadWall('f_first', wall, id)).detached?.reasons.join(' ')).toMatch(/beyond the ends/)
    })

    it('an oversized or too-high artwork still loads with its real numbers (the editor then flags them)', async () => {
      const { id, wall } = await saved()
      mock.resizeItem(id, { height: 260, elevation: 20 })
      const s = await adapter.loadWall('f_first', wall, id)
      expect(s.detached).toBeNull()
      expect(s.artwork).toMatchObject({ height: 260, v: 20 })
    })

    it('is not silently projected back onto the wall: the item is untouched after Reload', async () => {
      const { id, wall } = await saved()
      mock.moveItem(id, { x: 300 })
      await adapter.loadWall('f_first', wall, id)
      const rows = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: { x: number }[] }
      expect(rows.rows[0].x).toBe(300)
    })

    it('recovery uses the existing placement workflow: Apply by id moves the same object back, no duplicate', async () => {
      const { id, wall } = await saved()
      mock.moveItem(id, { x: 300, rotation: 0 })
      const s = await adapter.loadWall('f_first', wall, id)
      const r = await adapter.apply('f_first', wall, { width: 60, height: 40, u: 150, v: 100 }, s.rev, id)
      expect(r.artworkId).toBe(id)
      expect(r.created).toBe(false)
      const now = await adapter.loadWall('f_first', wall, id)
      expect(now.detached).toBeNull()
      expect(now.artwork!.u).toBeCloseTo(150)
      const rows = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: unknown[] }
      expect(rows.rows).toHaveLength(1)
    })
  })

  describe('missing things', () => {
    it('a deleted artwork is an error, not stale data', async () => {
      const { id, wall } = await saved()
      mock.deleteItem(id)
      await expect(adapter.loadWall('f_first', wall, id)).rejects.toMatchObject({ code: 'artwork_missing' })
      await expect(adapter.loadWall('f_first', wall, id)).rejects.toBeInstanceOf(MissingError)
    })

    it('Apply with the id of a deleted artwork refuses instead of creating a duplicate', async () => {
      const { id, wall, rev } = await saved()
      mock.deleteItem(id)
      const s = await adapter.loadWall('f_first', wall) // plain load: no artwork
      expect(s.artwork).toBeNull()
      await expect(adapter.apply('f_first', wall, { width: 60, height: 40, u: 100, v: 100 }, s.rev, id)).rejects.toMatchObject({ code: 'artwork_missing' })
      const rows = (await mock.call('list_entities', { floor: 'f_first', type: ['item'] })).data as { rows: unknown[] }
      expect(rows.rows).toHaveLength(0)
      expect(rev).toBeGreaterThan(0)
    })

    it('a wall that is gone is reported as such', async () => {
      const { id, wall } = await saved()
      mock.hideWall(wall)
      await expect(adapter.loadWall('f_first', wall, id)).rejects.toMatchObject({ code: 'wall_missing' })
    })

    it('an unknown item id is a missing artwork', async () => {
      await expect(adapter.loadWall('f_first', 'fl_east', 'i_nope')).rejects.toMatchObject({ code: 'artwork_missing' })
    })
  })

  describe('revisions', () => {
    it('Reload returns the current revision, and the next Apply uses it (the old one is refused)', async () => {
      const { id, wall, rev: oldRev } = await saved()
      const p = planPoint(frameOf(wall), 250, flushPerp(15, 3))
      mock.moveItem(id, { x: p.x, y: p.y }) // external edit bumps the revision
      const art = { width: 60, height: 40, u: 120, v: 100 }
      await expect(adapter.apply('f_first', wall, art, oldRev, id)).rejects.toBeInstanceOf(StaleError)
      const reloaded = await adapter.loadWall('f_first', wall, id)
      expect(reloaded.rev).toBeGreaterThan(oldRev)
      const r = await adapter.apply('f_first', wall, art, reloaded.rev, id)
      expect(r.artworkId).toBe(id)
      expect(r.artwork.u).toBeCloseTo(120)
    })

    it('if FloorGen changes while reading, the snapshot is re-read and is consistent', async () => {
      const { id, wall } = await saved()
      let changed = false
      const racing: Gateway = {
        kind: 'mock',
        call: async (tool, args) => {
          const res = await mock.call(tool, args)
          if (!changed && tool === 'list_entities') {
            changed = true
            mock.touch() // an external edit lands between two of Reload's reads
          }
          return res
        },
      }
      const s = await new WallSnapAdapter(racing, 'mock-project').loadWall('f_first', wall, id)
      expect(changed).toBe(true)
      const now = await mock.call('list_floors', {})
      expect(s.rev).toBe(now.rev) // the retry saw the post-edit revision throughout
    })

    it('if FloorGen keeps changing it gives up with a stale error rather than mixing revisions', async () => {
      const { id, wall } = await saved()
      const churn: Gateway = {
        kind: 'mock',
        call: async (tool, args) => {
          const res = await mock.call(tool, args)
          mock.touch()
          return res
        },
      }
      await expect(new WallSnapAdapter(churn, 'mock-project').loadWall('f_first', wall, id)).rejects.toBeInstanceOf(StaleError)
    })
  })
})
