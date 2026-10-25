import { describe, expect, it } from 'vitest'
import { facingRotation, wallFrame, type Pt } from '../geometry'
import { EXACT_TOL_CM, describeMatch, matchGenericArtwork, type WallContext } from './matching'
import { clusterSolidTriangles, clusterSolids, withoutTriangles, type Solid } from './solids'
import { CM, expectedAabbCm, type PlanItem } from './transform'

const room: Pt = { x: 400, y: 300 }
const THICK = 15
const BASE = 250

/** The solid FloorGen would export for an item: its predicted box, in metres. */
const solidFor = (it: PlanItem, base = BASE): Solid => {
  const e = expectedAabbCm(it, base)
  return { box: { min: e.min.map((n) => n * CM) as Solid['box']['min'], max: e.max.map((n) => n * CM) as Solid['box']['max'] }, triangles: Array.from({ length: 12 }, (_, i) => i) }
}
/** An item hung flush on a wall at distance u from endpoint A. */
function hung(a: Pt, b: Pt, u: number, over: Partial<PlanItem> = {}) {
  const frame = wallFrame(a, b, room)
  const flush = THICK / 2 + 1.5
  const item: PlanItem = {
    x: a.x + frame.dir.x * u + frame.normal.x * flush, y: a.y + frame.dir.y * u + frame.normal.y * flush,
    rotation: facingRotation(frame.normal), width: 100, height: 60, depth: 3, elevation: 100, ...over,
  }
  const wall: WallContext = { frame, thickness: THICK, baseCm: BASE, wallHeightCm: 250 }
  return { item, wall }
}

const WALLS: [string, Pt, Pt][] = [
  ['north (A west)', { x: 100, y: 100 }, { x: 700, y: 100 }],
  ['south (A east, reversed)', { x: 700, y: 500 }, { x: 100, y: 500 }],
  ['west (A north)', { x: 100, y: 100 }, { x: 100, y: 500 }],
  ['east (A north)', { x: 700, y: 100 }, { x: 700, y: 500 }],
  ['slanted', { x: 100, y: 500 }, { x: 600, y: 200 }],
]

describe.each(WALLS)('generic artwork matching on the %s wall', (_n, a, b) => {
  it('finds the exact solid even among unrelated ones, and says so with a ~0 error', () => {
    const { item, wall } = hung(a, b, 250)
    const other = solidFor({ ...item, x: 400, y: 300, elevation: 0, width: 200, height: 80, depth: 90 }) // a sofa elsewhere
    const r = matchGenericArtwork([other, solidFor(item)], item, wall)
    expect(r).toMatchObject({ status: 'exact', solid: 1 })
    expect(r.errorMm).toBeLessThan(0.01)
  })

  it('is stale, and picks the one solid on this wall, when the artwork moved along it since the export', () => {
    const { item, wall } = hung(a, b, 250)
    const oldPlace = hung(a, b, 120).item // where it hung when the model was exported
    const r = matchGenericArtwork([solidFor(oldPlace)], item, wall)
    expect(r).toMatchObject({ status: 'stale', solid: 0, candidates: 1 })
  })

  it('is stale when it was only resized or raised since the export', () => {
    const { item, wall } = hung(a, b, 250)
    const old = { ...item, width: 80, height: 40, elevation: 140 }
    expect(matchGenericArtwork([solidFor(old)], item, wall).status).toBe('stale')
  })

  it('is ambiguous, and picks nothing, when two generic solids hang on the wall and none is exact', () => {
    const { item, wall } = hung(a, b, 200) // walls are 400 to 600 cm long, so keep every position within 400
    const r = matchGenericArtwork([solidFor(hung(a, b, 60).item), solidFor(hung(a, b, 340).item)], item, wall)
    expect(r).toMatchObject({ status: 'ambiguous', candidates: 2 })
    expect(r.solid).toBeUndefined()
  })

  it('an exact match wins over other solids on the same wall', () => {
    const { item, wall } = hung(a, b, 300)
    const r = matchGenericArtwork([solidFor(hung(a, b, 100).item), solidFor(item)], item, wall)
    expect(r).toMatchObject({ status: 'exact', solid: 1, candidates: 2 })
  })

  it('finds nothing when the only generic solid is on another wall or another floor', () => {
    const { item, wall } = hung(a, b, 250)
    const elsewhere = hung(b, a, 100, { x: 400, y: 300, elevation: 100 }).item // mid-room
    expect(matchGenericArtwork([solidFor(elsewhere)], item, wall).status).toBe('none')
    expect(matchGenericArtwork([solidFor(item, 0)], item, wall).status).toBe('none') // same plan spot, but the storey below
    expect(matchGenericArtwork([], item, wall)).toEqual({ status: 'none', candidates: 0 })
  })

  it('has nothing to hide for an artwork that has never been saved', () => {
    const { item, wall } = hung(a, b, 250)
    expect(matchGenericArtwork([solidFor(item)], null, wall)).toEqual({ status: 'unsaved', candidates: 0 })
  })
})

describe('matching tolerance and determinism', () => {
  const { item, wall } = hung({ x: 100, y: 100 }, { x: 700, y: 100 }, 300)
  it('accepts FloorGen/float32 rounding (< 1 mm) as exact but not a 2 mm difference', () => {
    const near = solidFor({ ...item, x: item.x + 0.04 })
    const far = solidFor({ ...item, x: item.x + 0.2 })
    expect(matchGenericArtwork([near], item, wall).status).toBe('exact')
    expect(matchGenericArtwork([far], item, wall).status).toBe('stale') // still the only one on this wall
    expect(EXACT_TOL_CM).toBe(0.1)
  })
  it('gives identical answers for any ordering of the solids', () => {
    const solids = [solidFor(hung({ x: 100, y: 100 }, { x: 700, y: 100 }, 100).item), solidFor(item), solidFor({ ...item, x: 500, y: 300, elevation: 0, depth: 80 })]
    const a = matchGenericArtwork(solids, item, wall)
    const b = matchGenericArtwork([...solids].reverse(), item, wall)
    expect([a.status, solids[a.solid!].box]).toEqual([b.status, [...solids].reverse()[b.solid!].box])
  })
  it('two identical exact boxes cannot be told apart, so nothing is hidden', () => {
    expect(matchGenericArtwork([solidFor(item), solidFor(item)], item, wall).status).toBe('ambiguous')
  })
  it('describes each outcome, and says nothing when there is nothing to say', () => {
    expect(describeMatch({ status: 'exact', candidates: 1 })).toBeNull()
    expect(describeMatch({ status: 'unsaved', candidates: 0 })).toBeNull()
    expect(describeMatch({ status: 'stale', candidates: 1 })).toMatch(/exported before/)
    expect(describeMatch({ status: 'ambiguous', candidates: 2 })).toMatch(/2 placeholder artworks/)
    expect(describeMatch({ status: 'none', candidates: 0 })).toMatch(/not in the 3D model/)
  })
})

describe('clusterSolidTriangles and withoutTriangles', () => {
  const tri = (x: number, y: number, z: number) => [x, y, z, x + 1, y, z, x, y + 1, z]
  // Two separate "solids" of two triangles each (each pair shares a vertex position), interleaved.
  const data = [...tri(0, 0, 0), ...tri(10, 0, 0), ...[1, 0, 0, 1, 1, 0, 0, 1, 0], ...[11, 0, 0, 11, 1, 0, 10, 1, 0]]
  it('keeps each solid\'s triangle numbers, in model order', () => {
    const solids = clusterSolidTriangles(data)
    expect(solids.map((s) => s.triangles)).toEqual([[0, 2], [1, 3]])
    expect(solids[0].box).toEqual({ min: [0, 0, 0], max: [1, 1, 0] })
    expect(clusterSolids(data)).toEqual(solids.map((s) => s.box))
  })
  it('removes exactly the chosen triangles from an attribute array and nothing else', () => {
    const out = withoutTriangles(data, 3, new Set([0, 2]))
    expect(Array.from(out)).toEqual([...tri(10, 0, 0), ...[11, 0, 0, 11, 1, 0, 10, 1, 0]])
    expect(withoutTriangles(data, 3, new Set()).length).toBe(data.length) // nothing removed: same data
    expect(withoutTriangles(data, 3, new Set([99])).length).toBe(data.length) // out-of-range ids ignored
    expect(Array.from(data)).toHaveLength(36) // the source is never mutated
  })
})
