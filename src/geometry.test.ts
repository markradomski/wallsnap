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
