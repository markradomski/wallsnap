import { describe, expect, it } from 'vitest'
import { facingRotation, planPoint, wallFrame } from '../src/geometry'
import { clusterSolids } from './solids'
import {
  boxError, expectedAabbCm, fitContain, floorBaseCm, frontDirection, placementFor, planToWorld, planeAxes, planeRotationY, type PlanItem,
} from './transform'

const item = (extra: Partial<PlanItem> = {}): PlanItem => ({ x: 300, y: 200, rotation: 0, width: 100, height: 60, depth: 3, elevation: 90, ...extra })

describe('plan -> world', () => {
  it('maps centimetres to metres: X from plan x, Z from plan y (no flip), Y from base + elevation', () => {
    expect(planToWorld(550, 485.7, 100, 220)).toEqual([5.5, 3.2, 4.857])
    expect(planToWorld(0, 0, 0, 0)).toEqual([0, 0, 0])
  })
  it('keeps the plan\'s handedness: east is +X, and south (plan y increasing, down the page) is +Z', () => {
    const o = planToWorld(100, 100, 0, 0)
    const east = planToWorld(200, 100, 0, 0)
    const south = planToWorld(100, 200, 0, 0)
    expect(east[0]).toBeGreaterThan(o[0])
    expect(south[2]).toBeGreaterThan(o[2])
  })
  it('floor base is the summed heights of the floors below, lowest first', () => {
    const floors = [{ id: 'g', height: 220 }, { id: 'f1', height: 220 }, { id: 'f2', height: 250 }]
    expect([floorBaseCm(floors, 'g'), floorBaseCm(floors, 'f1'), floorBaseCm(floors, 'f2')]).toEqual([0, 220, 440])
    expect(() => floorBaseCm(floors, 'nope')).toThrow(/Unknown floor/)
  })
})

describe('facing and rotation', () => {
  it.each([[0, 0, 1], [90, -1, 0], [180, 0, -1], [270, 1, 0]])('θ=%i faces world (X,Z) = (%i, %i)', (deg, x, z) => {
    const f = frontDirection(deg)
    expect(f.x).toBeCloseTo(x, 12)
    expect(f.z).toBeCloseTo(z, 12)
  })

  it('a plane rotated by -θ about Y has its normal on the item front, for every θ', () => {
    for (const deg of [0, 30, 90, 135, 180, 225, 270, 359]) {
      const { normal } = planeAxes(planeRotationY(deg))
      const f = frontDirection(deg)
      expect(normal[0]).toBeCloseTo(f.x, 12)
      expect(normal[2]).toBeCloseTo(f.z, 12)
    }
  })

  it('image left-to-right reads correctly: local +X is to the viewer\'s right when facing the front', () => {
    // Viewer in front of the picture looks along -normal; with Y up, their right is (-normal) x Y.
    for (const deg of [0, 90, 180, 270, 45]) {
      const { normal, right } = planeAxes(planeRotationY(deg))
      const forward = [-normal[0], 0, -normal[2]]
      const viewerRight = [forward[1] * 0 - forward[2] * 1, 0, forward[0] * 1 - forward[1] * 0] // forward × up(0,1,0)
      expect(right[0]).toBeCloseTo(viewerRight[0], 12)
      expect(right[2]).toBeCloseTo(viewerRight[2], 12)
    }
  })

  it('north wall (θ=0): faces the room to the south, image runs west to east', () => {
    const { normal, right } = planeAxes(planeRotationY(0))
    expect(normal.map((n) => n + 0)).toEqual([0, 0, 1]) // `+ 0` normalises -0
    expect(right.map((n) => n + 0)).toEqual([1, 0, 0])
  })

  it('agrees with the geometry the app already uses: an item hung with facingRotation faces the room, on every wall direction', () => {
    const room = { x: 400, y: 300 }
    const walls: [number, number, number, number][] = [
      [100, 100, 700, 100], [700, 500, 100, 500], [100, 500, 100, 100], [700, 100, 700, 500], // axis-aligned, both directions
      [0, 0, 300, 400], [300, 400, 0, 0], // slanted
    ]
    for (const [ax, ay, bx, by] of walls) {
      const f = wallFrame({ x: ax, y: ay }, { x: bx, y: by }, room)
      const deg = facingRotation(f.normal)
      const front = frontDirection(deg)
      // facingRotation rounds to 0.001°, which is ~1e-6 in the normal: far finer than anything visible.
      expect(front.x).toBeCloseTo(f.normal.x, 4)
      expect(front.z).toBeCloseTo(f.normal.y, 4)
      // and the plane built for it faces the same way in the world
      const { normal } = planeAxes(planeRotationY(deg))
      expect(normal[0]).toBeCloseTo(f.normal.x, 4)
      expect(normal[2]).toBeCloseTo(f.normal.y, 4)
    }
  })
})

describe('placement of the textured plane', () => {
  it('sits in front of the generic solid by half its depth plus the gap, centred on the item', () => {
    const p = placementFor(item({ x: 300, y: 485.7, depth: 3, width: 100, height: 60, elevation: 90 }), 220, 0.2)
    expect(p.position[0]).toBeCloseTo(3.0, 9)
    expect(p.position[1]).toBeCloseTo((220 + 90 + 30) * 0.01, 9) // vertical centre of the picture
    expect(p.position[2]).toBeCloseTo((485.7 + 1.5 + 0.2) * 0.01, 9) // front face (+1.5) plus 2 mm
    expect(p.normal.map((n) => n + 0)).toEqual([0, 0, 1])
  })
  it('moves along the front direction for a south wall too (θ=180 faces north, -Z)', () => {
    const p = placementFor(item({ x: 519.1, y: 920.5, rotation: 180 }), 220, 0.2)
    expect(p.position[2]).toBeCloseTo((920.5 - 1.7) * 0.01, 9)
    expect(p.rotationY).toBeCloseTo(-Math.PI, 12)
  })
  it('the gap is the only difference between plane and solid front, and never in front of the viewer\'s side wrongly', () => {
    for (const deg of [0, 90, 180, 270]) {
      const solid = placementFor(item({ rotation: deg }), 0, 0)
      const plane = placementFor(item({ rotation: deg }), 0, 0.2)
      const d = [plane.position[0] - solid.position[0], plane.position[2] - solid.position[2]]
      expect(d[0] * solid.normal[0] + d[1] * solid.normal[2]).toBeCloseTo(0.002, 9) // exactly 2 mm along the front
    }
  })
})

describe('fitContain: the image is shown whole, never stretched', () => {
  it('fits by the limiting side and keeps the ratio', () => {
    expect(fitContain(120, 80, 2)).toEqual({ width: 120, height: 60 }) // wide image in a squarer frame
    expect(fitContain(120, 80, 1)).toEqual({ width: 80, height: 80 }) // square image in a wide frame
    const f = fitContain(135.9, 85, 1.6)
    expect(f.width / f.height).toBeCloseTo(1.6, 12)
    expect(f.width).toBeLessThanOrEqual(135.9)
    expect(f.height).toBeLessThanOrEqual(85 + 1e-9)
  })
  it('matches the frame exactly when the shapes agree', () => {
    expect(fitContain(160, 100, 1.6)).toEqual({ width: 160, height: 100 })
  })
})

describe('expected solid box (what the GLB must contain)', () => {
  it('is the item\'s footprint: width along X, depth along Z for θ=0/180, swapped for 90/270', () => {
    const a = expectedAabbCm(item({ x: 300, y: 200, rotation: 0 }), 220)
    expect(a).toEqual({ min: [250, 310, 198.5], max: [350, 370, 201.5] })
    const b = expectedAabbCm(item({ x: 300, y: 200, rotation: 90 }), 220)
    expect(b.min[0]).toBeCloseTo(298.5, 9)
    expect(b.max[2]).toBeCloseTo(250, 9)
    expect(expectedAabbCm(item({ rotation: 180 }), 0)).toEqual(expectedAabbCm(item({ rotation: 0 }), 0)) // symmetric box
  })
  it('boxError is the largest per-axis difference', () => {
    const a = expectedAabbCm(item(), 0)
    expect(boxError(a, a)).toBe(0)
    expect(boxError(a, { min: [a.min[0] + 0.03, a.min[1], a.min[2]], max: a.max })).toBeCloseTo(0.03, 12)
  })
})

describe('clusterSolids: separating the merged artwork solids in a non-indexed mesh', () => {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] => {
    const c = (x: number, y: number, z: number) => [x, y, z]
    const v = [c(x0, y0, z0), c(x1, y0, z0), c(x1, y1, z0), c(x0, y1, z0), c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)]
    const tris = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7], [1, 5, 6], [1, 6, 2], [0, 3, 7], [0, 7, 4]]
    return tris.flatMap((t) => t.flatMap((i) => v[i]))
  }
  it('finds each solid and its bounds', () => {
    const data = [...box(1.894, 2.792, 4.842, 3.806, 3.995, 4.872), ...box(5.011, 3.442, 9.19, 5.371, 3.928, 9.22)]
    const solids = clusterSolids(data)
    expect(solids).toHaveLength(2)
    const sorted = solids.sort((a, b) => a.min[0] - b.min[0])
    expect(sorted[0].min).toEqual([1.894, 2.792, 4.842])
    expect(sorted[1].max).toEqual([5.371, 3.928, 9.22])
  })
  it('treats a single box as one solid and an empty mesh as none', () => {
    expect(clusterSolids(box(0, 0, 0, 1, 1, 1))).toHaveLength(1)
    expect(clusterSolids([])).toEqual([])
  })
  it('round-trips with expectedAabbCm for a real placement', () => {
    const it0 = item({ x: 285, y: 485.7, width: 191.2, height: 120.3, elevation: 59.2, depth: 3 })
    const e = expectedAabbCm(it0, 220)
    const m = (n: number) => n * CM_
    const data = box(m(e.min[0]), m(e.min[1]), m(e.min[2]), m(e.max[0]), m(e.max[1]), m(e.max[2]))
    const [solid] = clusterSolids(data)
    const back = { min: solid.min.map((n) => n / CM_) as [number, number, number], max: solid.max.map((n) => n / CM_) as [number, number, number] }
    expect(boxError(back, e)).toBeLessThan(1e-9)
    // and planPoint from the app's wall frame lands on the same plan x (one conversion, not two)
    const north = wallFrame({ x: 150, y: 476.98 }, { x: 850, y: 476.98 }, { x: 500, y: 703 })
    expect(planPoint(north, 135, 8.67).x).toBeCloseTo(285, 9)
  })
})

const CM_ = 0.01
