import { describe, expect, it } from 'vitest'
import {
  clampToWall, facingRotation, nudge, overlapsOpening, planPoint, validate, wallCoords, wallFrame, type Pt,
} from './geometry'
import type { Artwork, Opening } from './types'

const wall = { length: 600, height: 250, openings: [] as Opening[] }
const art: Artwork = { width: 100, height: 70, u: 300, v: 100 }
const win: Opening = { id: 'o', kind: 'window', left: 200, width: 120, sill: 90, height: 120 }

describe('clampToWall', () => {
  it('keeps the rectangle inside the wall on every side', () => {
    expect(clampToWall(wall, { ...art, u: -50 }).u).toBe(50)
    expect(clampToWall(wall, { ...art, u: 9999 }).u).toBe(550)
    expect(clampToWall(wall, { ...art, v: 9999 }).v).toBe(180)
    expect(clampToWall(wall, { ...art, v: -5 }).v).toBe(0)
  })
  it('limits height to 200 cm and width to the wall length', () => {
    expect(clampToWall(wall, { ...art, height: 500 }).height).toBe(200)
    expect(clampToWall(wall, { ...art, width: 900 }).width).toBe(600)
  })
  it('limits height to a wall shorter than 200 cm', () => {
    expect(clampToWall({ length: 300, height: 150 }, { ...art, height: 190 }).height).toBe(150)
  })
})

describe('nudge', () => {
  it('moves by the requested centimetres', () => {
    expect(nudge(wall, art, 1, 0)).toMatchObject({ u: 301, v: 100 })
    expect(nudge(wall, art, 0, -10)).toMatchObject({ u: 300, v: 90 })
  })
  it('stops at corners instead of leaving the wall', () => {
    expect(nudge(wall, { ...art, u: 50 }, -10, 0).u).toBe(50)
    expect(nudge(wall, { ...art, u: 550, v: 0 }, 10, -10)).toMatchObject({ u: 550, v: 0 })
  })
})

describe('validate: boundaries and corners', () => {
  it('accepts a rectangle exactly touching both wall ends, floor and top', () => {
    expect(validate(wall, { width: 100, height: 70, u: 50, v: 0 })).toEqual([])
    expect(validate(wall, { width: 100, height: 70, u: 550, v: 180 })).toEqual([])
  })
  it('accepts a full-width artwork', () => {
    expect(validate(wall, { width: 600, height: 70, u: 300, v: 10 })).toEqual([])
  })
  it('rejects the smallest overhang at each edge', () => {
    expect(validate(wall, { ...art, u: 49.9 })).toContain('Artwork extends past the wall ends.')
    expect(validate(wall, { ...art, u: 550.1 })).toContain('Artwork extends past the wall ends.')
    expect(validate(wall, { ...art, v: -0.1 })).toContain('Bottom height cannot be below the floor.')
    expect(validate(wall, { ...art, v: 180.1 }).join()).toMatch(/wall height/)
  })
})

describe('validate: invalid dimensions', () => {
  it.each([0, -5, NaN, Infinity])('rejects width/height %s', (bad) => {
    expect(validate(wall, { ...art, width: bad })).not.toEqual([])
    expect(validate(wall, { ...art, height: bad })).not.toEqual([])
  })
  it('allows exactly 200 cm high but not more', () => {
    expect(validate(wall, { ...art, height: 200, v: 0 })).toEqual([])
    expect(validate(wall, { ...art, height: 200.1, v: 0 }).join()).toMatch(/exceed 200/)
  })
  it('rejects artwork wider than the wall', () => {
    expect(validate(wall, { ...art, width: 601 }).join()).toMatch(/wall length/)
  })
  it('rejects non-finite positions', () => {
    expect(validate(wall, { ...art, u: NaN })).toEqual(['All values must be numbers.'])
  })
})

describe('openings', () => {
  const w = { ...wall, openings: [win] }
  it('rejects overlap with a window', () => {
    expect(validate(w, { ...art, u: 260 }).join()).toMatch(/door or window/)
  })
  it('allows an artwork that only touches the opening edge', () => {
    expect(overlapsOpening({ ...art, u: 150 }, win)).toBe(false) // right edge u=200 == opening left
    expect(overlapsOpening({ ...art, u: 370 }, win)).toBe(false) // left edge u=320 == opening right
    expect(overlapsOpening({ ...art, v: 210, height: 30 }, win)).toBe(false) // bottom == opening top
    expect(overlapsOpening({ ...art, v: 20, height: 70 }, win)).toBe(false) // top == sill
  })
  it('allows hanging above or below the opening', () => {
    expect(validate(w, { ...art, u: 260, v: 215, height: 30 })).toEqual([])
    expect(validate(w, { ...art, u: 260, v: 10, height: 60 })).toEqual([])
  })
})

describe('wall frame: A is authoritative, including reversed walls', () => {
  const room: Pt = { x: 400, y: 300 }
  const forward = wallFrame({ x: 100, y: 100 }, { x: 700, y: 100 }, room)
  const reversed = wallFrame({ x: 700, y: 100 }, { x: 100, y: 100 }, room)

  it('measures u from endpoint A whichever way the wall is stored', () => {
    expect(planPoint(forward, 150, 0)).toEqual({ x: 250, y: 100 })
    expect(planPoint(reversed, 150, 0)).toEqual({ x: 550, y: 100 })
  })
  it('hangs on the room face for either direction', () => {
    expect(forward.normal).toEqual({ x: 0, y: 1 })
    expect(reversed.normal).toEqual({ x: 0, y: 1 })
    expect(facingRotation(forward.normal)).toBe(0)
    expect(facingRotation(reversed.normal)).toBe(0)
  })
  it('turns the item to face the room on every side', () => {
    const north = wallFrame({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 })
    const east = wallFrame({ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 50, y: 50 })
    const south = wallFrame({ x: 100, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 50 })
    const west = wallFrame({ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 50, y: 50 })
    expect([north, east, south, west].map((f) => facingRotation(f.normal))).toEqual([0, 90, 180, 270]) // west = 270 matches FloorGen (verified live)
  })
  it('puts the room on the chosen side for the same wall', () => {
    const other = wallFrame({ x: 100, y: 100 }, { x: 700, y: 100 }, { x: 400, y: -200 })
    expect(other.normal).toEqual({ x: 0, y: -1 })
    expect(facingRotation(other.normal)).toBe(180)
  })
  it('rejects a degenerate wall', () => {
    expect(() => wallFrame({ x: 5, y: 5 }, { x: 5, y: 5 }, room)).toThrow(/Degenerate/)
  })
})

describe('coordinate round trips', () => {
  const walls: [string, Pt, Pt, Pt][] = [
    ['horizontal', { x: 100, y: 100 }, { x: 700, y: 100 }, { x: 400, y: 300 }],
    ['reversed', { x: 700, y: 100 }, { x: 100, y: 100 }, { x: 400, y: 300 }],
    ['vertical', { x: 100, y: 500 }, { x: 100, y: 100 }, { x: 400, y: 300 }],
    ['diagonal', { x: 0, y: 0 }, { x: 300, y: 400 }, { x: 400, y: 100 }],
    ['diagonal reversed', { x: 300, y: 400 }, { x: 0, y: 0 }, { x: 400, y: 100 }],
  ]
  it.each(walls)('planPoint <-> wallCoords on a %s wall', (_n, a, b, room) => {
    const f = wallFrame(a, b, room)
    for (const u of [0, 0.5, f.length / 2, f.length]) {
      const c = wallCoords(f, planPoint(f, u, 8.5))
      expect(c.u).toBeCloseTo(u, 9)
      expect(c.perp).toBeCloseTo(8.5, 9)
    }
  })
  it('keeps the room on the positive perpendicular side', () => {
    for (const [, a, b, room] of walls) {
      const f = wallFrame(a, b, room)
      expect(wallCoords(f, room).perp).toBeGreaterThan(0)
    }
  })
})

import { extent, handlePoint, resizeFromHandle, type Handle } from './geometry'

describe('resizeFromHandle', () => {
  const dims = { length: 600, height: 250 }
  const a: Artwork = { width: 100, height: 60, u: 300, v: 100 } // u 250..350, v 100..160

  it('east edge moves only the +u edge; west edge is anchored', () => {
    const r = resizeFromHandle(dims, a, 'e', { u: 400, v: 9999 })
    expect(extent(r)).toEqual({ u0: 250, u1: 400, v0: 100, v1: 160 })
    expect(r).toMatchObject({ width: 150, height: 60, u: 325, v: 100 })
  })
  it('west edge moves only the -u edge; east edge is anchored', () => {
    const r = resizeFromHandle(dims, a, 'w', { u: 200, v: 0 })
    expect(extent(r)).toEqual({ u0: 200, u1: 350, v0: 100, v1: 160 })
  })
  it('north edge grows upward and keeps v; south edge keeps the top', () => {
    expect(extent(resizeFromHandle(dims, a, 'n', { u: 0, v: 200 }))).toEqual({ u0: 250, u1: 350, v0: 100, v1: 200 })
    expect(extent(resizeFromHandle(dims, a, 's', { u: 0, v: 40 }))).toEqual({ u0: 250, u1: 350, v0: 40, v1: 160 })
  })
  it.each<[Handle, { u: number; v: number }, { u0: number; u1: number; v0: number; v1: number }]>([
    ['ne', { u: 380, v: 190 }, { u0: 250, u1: 380, v0: 100, v1: 190 }],
    ['nw', { u: 220, v: 190 }, { u0: 220, u1: 350, v0: 100, v1: 190 }],
    ['se', { u: 380, v: 70 }, { u0: 250, u1: 380, v0: 70, v1: 160 }],
    ['sw', { u: 220, v: 70 }, { u0: 220, u1: 350, v0: 70, v1: 160 }],
  ])('%s corner resizes both axes with the opposite corner anchored', (h, to, want) => {
    expect(extent(resizeFromHandle(dims, a, h, to))).toEqual(want)
  })

  it('stops at the wall ends, floor and ceiling', () => {
    expect(extent(resizeFromHandle(dims, a, 'e', { u: 9999, v: 0 })).u1).toBe(600)
    expect(extent(resizeFromHandle(dims, a, 'w', { u: -50, v: 0 })).u0).toBe(0)
    expect(extent(resizeFromHandle(dims, a, 's', { u: 0, v: -50 })).v0).toBe(0)
    expect(extent(resizeFromHandle({ ...dims, height: 150 }, a, 'n', { u: 0, v: 999 })).v1).toBe(150)
  })
  it('enforces the 200 cm maximum height from either edge', () => {
    expect(resizeFromHandle(dims, { ...a, v: 20 }, 'n', { u: 0, v: 249 })).toMatchObject({ v: 20, height: 200 })
    expect(resizeFromHandle(dims, a, 's', { u: 0, v: 0 })).toMatchObject({ v: 0, height: 160 }) // floor binds before the limit
    expect(resizeFromHandle(dims, { ...a, v: 150, height: 90 }, 's', { u: 0, v: 0 })).toMatchObject({ v: 40, height: 200 })
  })
  it('keeps dimensions positive: an edge cannot cross its anchor', () => {
    expect(resizeFromHandle(dims, a, 'e', { u: 100, v: 0 }).width).toBe(1)
    expect(resizeFromHandle(dims, a, 'w', { u: 900, v: 0 })).toMatchObject({ width: 1, u: 349.5 })
    expect(resizeFromHandle(dims, a, 'n', { u: 0, v: 0 }).height).toBe(1)
    expect(resizeFromHandle(dims, a, 's', { u: 0, v: 999 })).toMatchObject({ height: 1, v: 159 })
  })
  it('keeps u centre-based: the centre moves by half the edge movement', () => {
    expect(resizeFromHandle(dims, a, 'e', { u: 370, v: 0 }).u).toBe(310)
    expect(resizeFromHandle(dims, a, 'w', { u: 230, v: 0 }).u).toBe(290)
  })
  it('never produces an invalid placement', () => {
    const wallFull = { ...dims, openings: [] }
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Handle[]) {
      for (const to of [{ u: -999, v: -999 }, { u: 9999, v: 9999 }, { u: 300, v: 130 }]) {
        expect(validate(wallFull, resizeFromHandle(dims, a, h, to))).toEqual([])
      }
    }
  })
  it('handlePoint reports edge midpoints and corners', () => {
    expect(handlePoint(a, 'e')).toEqual({ u: 350, v: 130 })
    expect(handlePoint(a, 'n')).toEqual({ u: 300, v: 160 })
    expect(handlePoint(a, 'sw')).toEqual({ u: 250, v: 100 })
  })

  it('on a reversed wall the +u (east) edge still moves towards B in the plan', () => {
    // A is the east end here, so growing towards B means moving west in the plan.
    const rev = wallFrame({ x: 700, y: 100 }, { x: 100, y: 100 }, { x: 400, y: 300 })
    const grown = resizeFromHandle({ length: rev.length, height: 250 }, a, 'e', { u: 400, v: 0 })
    const edgeBefore = planPoint(rev, extent(a).u1, 0)
    const edgeAfter = planPoint(rev, extent(grown).u1, 0)
    expect(edgeAfter.x).toBeLessThan(edgeBefore.x)
    expect(planPoint(rev, extent(grown).u0, 0)).toEqual(planPoint(rev, extent(a).u0, 0)) // anchored
  })
})

import { dimensionLabelPlacement } from './geometry'

describe('dimensionLabelPlacement', () => {
  const wall = { length: 600, height: 250 }
  const label = { w: 80, h: 20 }
  const scale = 1 // 1 px per cm keeps the arithmetic obvious
  const clearance = 17
  const place = (a: Artwork, s = scale) => dimensionLabelPlacement(wall, a, s, label, clearance)

  it('sits above a mid-wall artwork, outside it and clear of the handle hit areas', () => {
    const a = { width: 100, height: 60, u: 300, v: 100 }
    const p = place(a)
    expect(p.placement).toBe('above')
    // label bottom edge = centre - h/2 must be above the top edge by at least the clearance
    expect(p.v - label.h / 2 - (a.v + a.height)).toBeGreaterThanOrEqual(clearance)
    expect(p.u).toBe(300)
  })

  it('moves below when the artwork is hard against the ceiling', () => {
    const a = { width: 100, height: 60, u: 300, v: 190 } // top at 250
    const p = place(a)
    expect(p.placement).toBe('below')
    expect(a.v - (p.v + label.h / 2)).toBeGreaterThanOrEqual(clearance)
  })

  it('stays above when the artwork is on the floor', () => {
    expect(place({ width: 100, height: 60, u: 300, v: 0 }).placement).toBe('above')
  })

  it('falls inside only when there is no room above or below', () => {
    const tall = { width: 100, height: 200, u: 300, v: 25 } // 25 cm above and below < 39 px needed
    const p = place(tall)
    expect(p.placement).toBe('inside')
    expect(p.v).toBe(125)
  })

  it('stays inside the wall horizontally at both ends', () => {
    const left = place({ width: 20, height: 40, u: 10, v: 100 })
    const right = place({ width: 20, height: 40, u: 590, v: 100 })
    expect(left.u).toBe(40) // label half width
    expect(right.u).toBe(560)
  })

  it('works for very small artwork and for all four boundaries at once', () => {
    for (const a of [
      { width: 1, height: 1, u: 0.5, v: 0 }, { width: 1, height: 1, u: 599.5, v: 249 },
      { width: 1, height: 1, u: 0.5, v: 249 }, { width: 1, height: 1, u: 599.5, v: 0 },
    ]) {
      const p = place(a)
      expect(p.u - 40).toBeGreaterThanOrEqual(0)
      expect(p.u + 40).toBeLessThanOrEqual(600)
      expect(p.v - 10).toBeGreaterThanOrEqual(0)
      expect(p.v + 10).toBeLessThanOrEqual(250)
      expect(p.placement).not.toBe('inside')
    }
  })

  it('is independent of screen scale: the same px clearance means fewer cm when zoomed in', () => {
    const a = { width: 100, height: 60, u: 300, v: 100 }
    const gapCm = (s: number) => place(a, s).v - label.h / 2 / s - (a.v + a.height)
    expect(gapCm(1)).toBeCloseTo(17, 6)
    expect(gapCm(2)).toBeCloseTo(8.5, 6)
    expect(gapCm(0.5)).toBeCloseTo(34, 6)
  })

  it('centres on a wall narrower than the label', () => {
    const p = dimensionLabelPlacement({ length: 50, height: 250 }, { width: 20, height: 40, u: 10, v: 100 }, 1, label, clearance)
    expect(p.u).toBe(25)
  })
})

import { ATTACH_TOL_CM, flushPerp, offWallReasons, type PlacedItem } from './geometry'

describe('offWallReasons', () => {
  const room: Pt = { x: 400, y: 300 }
  const thickness = 15
  const depth = 3
  // North wall A(100,100) -> B(700,100), room to the south: faces rotation 0, flush at y = 100 + 9.
  const north = wallFrame({ x: 100, y: 100 }, { x: 700, y: 100 }, room)
  const placed = (f = north, u = 250, extra: Partial<PlacedItem> = {}, rotation = facingRotation(f.normal)): PlacedItem => {
    const p = planPoint(f, u, flushPerp(thickness, depth))
    return { x: p.x, y: p.y, rotation, width: 80, height: 50, depth, elevation: 120, ...extra }
  }

  it('accepts an item flush on the wall, facing the room', () => {
    expect(offWallReasons(north, thickness, placed())).toEqual([])
  })
  it('accepts it on reversed and slanted walls too', () => {
    const reversed = wallFrame({ x: 700, y: 100 }, { x: 100, y: 100 }, room)
    const slanted = wallFrame({ x: 0, y: 0 }, { x: 300, y: 400 }, { x: 400, y: 100 })
    expect(offWallReasons(reversed, thickness, placed(reversed))).toEqual([])
    expect(offWallReasons(slanted, thickness, placed(slanted, 100))).toEqual([])
  })
  it('tolerates small snapping noise but not a visible gap', () => {
    const p = placed()
    expect(offWallReasons(north, thickness, { ...p, y: p.y + ATTACH_TOL_CM - 0.1 })).toEqual([])
    expect(offWallReasons(north, thickness, { ...p, y: p.y + 10 })[0]).toMatch(/10 cm in front of the wall surface/)
  })
  it('reports an item pushed behind the wall surface', () => {
    const p = placed()
    expect(offWallReasons(north, thickness, { ...p, y: p.y - 20 })[0]).toMatch(/behind the wall surface/)
  })
  it('reports an item dragged to the middle of the room', () => {
    expect(offWallReasons(north, thickness, { ...placed(), y: 300 }).length).toBeGreaterThan(0)
  })
  it('reports an item rotated away from facing the room', () => {
    expect(offWallReasons(north, thickness, placed(north, 250, {}, 90))[0]).toMatch(/turned 90° away/)
    expect(offWallReasons(north, thickness, placed(north, 250, {}, 180))[0]).toMatch(/turned 180° away/)
  })
  it('treats 360° as 0° and small rotation noise as facing', () => {
    expect(offWallReasons(north, thickness, placed(north, 250, {}, 360))).toEqual([])
    expect(offWallReasons(north, thickness, placed(north, 250, {}, 1))).toEqual([])
  })
  it('reports a centre beyond the wall ends even when flush on the plane', () => {
    expect(offWallReasons(north, thickness, placed(north, 650))).toContain('Its centre is beyond the ends of this wall.')
    expect(offWallReasons(north, thickness, placed(north, -5))).toContain('Its centre is beyond the ends of this wall.')
  })
  it('does not call a partly overhanging item detached: that is a size/bounds problem the editor shows', () => {
    expect(offWallReasons(north, thickness, placed(north, 590, { width: 80 }))).toEqual([]) // edge at u 630 > 600? centre inside
  })
  it('never alters its inputs', () => {
    const p = placed()
    const copy = { ...p }
    offWallReasons(north, thickness, p)
    expect(p).toEqual(copy)
  })
})

describe('proportional resize (resizeFromHandle with keepRatio)', () => {
  const dims = { length: 600, height: 250 }
  const a: Artwork = { width: 80, height: 100, u: 300, v: 60 } // ratio 0.8; u 260..340, v 60..160
  const ratio = (r: Artwork) => r.width / r.height
  const lock = (h: Handle, to: { u: number; v: number }, art = a) => resizeFromHandle(dims, art, h, to, true)

  it.each<[Handle, { u: number; v: number }, { u0: number; v0: number; u1: number; v1: number }]>([
    // The opposite corner never moves; the pointer picks the larger of the two requested scales.
    ['ne', { u: 420, v: 200 }, { u0: 260, v0: 60, u1: 420, v1: 260 }],
    ['nw', { u: 180, v: 200 }, { u0: 180, v0: 60, u1: 340, v1: 260 }],
    ['se', { u: 420, v: 10 }, { u0: 260, v0: 10, u1: 420, v1: 160 }],
    ['sw', { u: 180, v: 10 }, { u0: 180, v0: 10, u1: 340, v1: 160 }],
  ])('%s corner keeps the ratio and the opposite corner', (h, to, want) => {
    const r = lock(h, to)
    expect(ratio(r)).toBeCloseTo(0.8, 12)
    const e = extent(r)
    // The anchored corner is unchanged.
    if (h.includes('e')) expect(e.u0).toBeCloseTo(260, 9)
    if (h.includes('w')) expect(e.u1).toBeCloseTo(340, 9)
    if (h.includes('n')) expect(e.v0).toBeCloseTo(60, 9)
    if (h.includes('s')) expect(e.v1).toBeCloseTo(160, 9)
    expect(r.width).toBeGreaterThan(80)
    // The anchored corner fixes where the rectangle starts; the far corner is clamped only by the wall and ratio.
    expect(want.u1 - want.u0).toBeGreaterThan(0)
  })

  it('a corner follows the dominant pointer axis', () => {
    // Pointer far to the right but barely up: width drives the scale.
    const wide = lock('ne', { u: 400, v: 165 })
    expect(wide.width).toBeCloseTo(140, 9)
    expect(ratio(wide)).toBeCloseTo(0.8, 12)
    // Pointer barely right but far up: height drives the scale.
    const tall = lock('ne', { u: 345, v: 200 })
    expect(tall.height).toBeCloseTo(140, 9)
    expect(ratio(tall)).toBeCloseTo(0.8, 12)
  })

  it('east/west edges keep the opposite edge and grow the height about the vertical centre', () => {
    const r = lock('e', { u: 420, v: 0 }) // width 80 -> 160, so height 100 -> 200
    expect(extent(r).u0).toBeCloseTo(260, 9)
    expect(r.width).toBeCloseTo(160, 9)
    expect(r.height).toBeCloseTo(200, 9)
    expect(r.v + r.height / 2).toBeCloseTo(110, 9) // centre height unchanged (v 60 + 50)
    const w = lock('w', { u: 180, v: 0 })
    expect(extent(w).u1).toBeCloseTo(340, 9)
    expect(w.height).toBeCloseTo(200, 9)
  })

  it('north/south edges keep the opposite edge and grow the width about the centre', () => {
    const n = lock('n', { u: 0, v: 210 }) // height 100 -> 150
    expect(extent(n).v0).toBeCloseTo(60, 9)
    expect(n.height).toBeCloseTo(150, 9)
    expect(n.width).toBeCloseTo(120, 9)
    expect(n.u).toBeCloseTo(300, 9)
    const s = lock('s', { u: 0, v: 10 })
    expect(extent(s).v1).toBeCloseTo(160, 9)
    expect(s.width).toBeCloseTo(0.8 * 150, 9)
  })

  it('stops at the wall boundary while still preserving the ratio', () => {
    const toEdge = lock('se', { u: 9999, v: -9999 })
    expect(extent(toEdge).u1).toBeLessThanOrEqual(600 + 1e-9)
    expect(ratio(toEdge)).toBeCloseTo(0.8, 12)
    const left = lock('sw', { u: -9999, v: -9999 })
    expect(extent(left).u0).toBeGreaterThanOrEqual(-1e-9)
    expect(extent(left).v0).toBeGreaterThanOrEqual(-1e-9)
    expect(ratio(left)).toBeCloseTo(0.8, 12)
  })

  it('respects the 200 cm height limit by shrinking both dimensions together', () => {
    const r = lock('n', { u: 0, v: 9999 })
    expect(r.height).toBeLessThanOrEqual(200 + 1e-9)
    expect(ratio(r)).toBeCloseTo(0.8, 12)
  })

  it('cannot collapse below 1 cm or flip through the anchor', () => {
    const r = lock('se', { u: -9999, v: 9999 })
    expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(ratio(r)).toBeCloseTo(0.8, 12)
    expect(extent(r).u0).toBeCloseTo(260, 9)
  })

  it('works for wide and tall ratios and on a wall too small for the frame', () => {
    const panorama: Artwork = { width: 200, height: 50, u: 300, v: 100 }
    expect(ratio(lock('se', { u: 500, v: 0 }, panorama))).toBeCloseTo(4, 12)
    const tiny = resizeFromHandle({ length: 60, height: 60 }, { width: 20, height: 40, u: 30, v: 10 }, 'e', { u: 999, v: 0 }, true)
    expect(tiny.width / tiny.height).toBeCloseTo(0.5, 12)
    expect(validate({ length: 60, height: 60, openings: [] }, tiny)).toEqual([])
  })

  it('for every handle and many pointer positions: ratio exact, inside the wall, valid', () => {
    const wallFull = { ...dims, openings: [] }
    const handles: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
    for (const h of handles) {
      for (const u of [-500, 0, 150, 260, 300, 340, 450, 700, 5000]) {
        for (const v of [-500, 0, 40, 60, 110, 160, 250, 400, 5000]) {
          const r = resizeFromHandle(dims, a, h, { u, v }, true)
          expect(ratio(r), `${h} ${u},${v}`).toBeCloseTo(0.8, 9)
          expect(validate(wallFull, r), `${h} ${u},${v}`).toEqual([])
        }
      }
    }
  })

  it('without keepRatio the free behaviour is unchanged', () => {
    expect(resizeFromHandle(dims, a, 'e', { u: 420, v: 0 })).toMatchObject({ width: 160, height: 100 })
  })

  it('works on repeated drags (no drift): rescaling then returning gives the original', () => {
    const big = lock('se', { u: 420, v: 10 })
    const back = lock('se', { u: 340, v: 60 }, big)
    expect(back.width).toBeCloseTo(80, 6)
    expect(back.height).toBeCloseTo(100, 6)
  })
})
