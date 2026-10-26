import { describe, expect, it } from 'vitest'
import type { StairInfo, WalkData } from '../types'
import { buildColliders, isTraversable, solidSpans, type Obb } from './walkGeometry'
import {
  applyLook, clearance, findStart, moveCircle, NO_KEYS, stepWalk, walkPhase, MAX_PITCH, RADIUS_CM, WALK_SPEED, type WalkState,
} from './walkMove'

const R = RADIUS_CM

/** A 600 x 400 room (centrelines (100,100)-(700,500)), 15 cm walls, nothing else. */
function room(over: Partial<WalkData> = {}): WalkData {
  const w = (id: string, a: [number, number], b: [number, number], thickness = 15) => ({ id, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] }, thickness })
  return {
    rev: 1, floorId: 'f', baseCm: 0,
    walls: [w('n', [100, 100], [700, 100]), w('e', [700, 100], [700, 500]), w('s', [700, 500], [100, 500]), w('w', [100, 500], [100, 100])],
    openings: [], items: [], stairs: [], stairsBelow: [], ...over,
  }
}
const door = (wallId: string, offset: number, width = 90, o: Partial<WalkData['openings'][number]> = {}) =>
  ({ id: `${wallId}${offset}`, wallId, kind: 'door', offset, width, sill: 0, height: 205, exterior: false, ...o })
const item = (id: string, x: number, y: number, rotation: number, width: number, depth: number, o: Partial<WalkData['items'][number]> = {}) =>
  ({ id, x, y, rotation, width, depth, height: 80, elevation: 0, ...o })

const walk = (start: { x: number; y: number }, heading: number, seconds: number, colliders: Obb[], keys = { forward: true }, fps = 60) => {
  let s: WalkState = { ...start, heading, pitch: 0 }
  for (let i = 0; i < Math.round(seconds * fps); i++) s = stepWalk(s, { ...NO_KEYS, ...keys }, 1 / fps, colliders)
  return s
}
const inside = (p: { x: number; y: number }) => p.x > 107.5 + R - 1e-3 && p.x < 692.5 - R + 1e-3 && p.y > 107.5 + R - 1e-3 && p.y < 492.5 - R + 1e-3

describe('walls', () => {
  const c = buildColliders(room())
  it('stops at a wall from either side, whatever the angle', () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const s = walk({ x: 400, y: 300 }, (deg * Math.PI) / 180, 12, c)
      expect(inside(s), `heading ${deg}`).toBe(true)
    }
    // from outside the building, into the same wall
    const out = walk({ x: 400, y: 40 }, Math.PI / 2, 5, c)
    expect(out.y).toBeLessThanOrEqual(100 - 7.5 - R + 1e-3)
  })
  it('rests exactly one radius from the wall face', () => {
    const s = walk({ x: 400, y: 300 }, -Math.PI / 2, 10, c)
    expect(s.y).toBeCloseTo(107.5 + R, 2)
  })
  it('slides along a wall when walking into it at an angle, keeping the along-wall speed component', () => {
    const s = walk({ x: 200, y: 300 }, -Math.PI / 4, 2.5, c) // up and to the right, into the north wall
    expect(s.y).toBeCloseTo(107.5 + R, 2)
    expect(s.x).toBeGreaterThan(200 + 100)
  })
  it('does not jitter while pressing against a wall', () => {
    let s: WalkState = { x: 400, y: 107.5 + R, heading: -Math.PI / 2, pitch: 0 }
    const ys = new Set<number>()
    for (let i = 0; i < 120; i++) {
      s = stepWalk(s, { ...NO_KEYS, forward: true }, 1 / 60, c)
      ys.add(+s.y.toFixed(6))
    }
    expect(ys.size).toBe(1)
  })
  it('closes corners: running into any of the four corners never gets through, with or without the diagonal', () => {
    for (const [x, y, h] of [[120, 120, -2.356], [680, 120, -0.785], [680, 480, 0.785], [120, 480, 2.356]] as const) {
      const s = walk({ x: 400, y: 300 }, Math.atan2(y - 300, x - 300) * 0 + h + Math.PI, 8, c)
      expect(inside(s)).toBe(true)
      const t = walk({ x: x === 120 ? 140 : 660, y: y === 120 ? 140 : 460 }, h, 8, c)
      expect(inside(t)).toBe(true)
    }
  })
  it('cannot tunnel through a thin wall at any speed, even from a huge frame', () => {
    const thin = buildColliders(room({ walls: room().walls.map((w) => ({ ...w, thickness: 4 })) }))
    let s: WalkState = { x: 400, y: 150, heading: -Math.PI / 2, pitch: 0 }
    for (let i = 0; i < 30; i++) s = stepWalk(s, { ...NO_KEYS, forward: true, fast: true }, 5 /* seconds: clamped */, thin)
    expect(s.y).toBeGreaterThan(100)
    // a single enormous raw move is substepped too
    const p = moveCircle({ x: 400, y: 150 }, { x: 0, y: -400 }, thin)
    expect(p.y).toBeGreaterThanOrEqual(100 + 2 + R - 1e-3)
  })
})

describe('doorways and windows', () => {
  const wide = buildColliders(room({ openings: [door('n', 300, 90)] }))
  it('keeps solid wall either side of a doorway and lets a wide doorway through', () => {
    // the door is 300 cm from endpoint A (x = 100), so its centre line is x = 400
    for (const x of [200, 340, 460, 600]) expect(walk({ x, y: 200 }, -Math.PI / 2, 3, wide).y, `x ${x}`).toBeGreaterThan(100) // blocked beside it
    const s = walk({ x: 400, y: 200 }, -Math.PI / 2, 3, wide) // straight at the doorway
    expect(s.y).toBeLessThan(60)
  })
  it('does not pass a doorway narrower than the body, but does pass one just wider', () => {
    const narrow = buildColliders(room({ openings: [door('n', 300, 2 * R - 2)] }))
    expect(walk({ x: 400, y: 200 }, -Math.PI / 2, 3, narrow).y).toBeGreaterThan(100)
    const snug = buildColliders(room({ openings: [door('n', 300, 2 * R + 4)] }))
    expect(walk({ x: 400, y: 200 }, -Math.PI / 2, 3, snug).y).toBeLessThan(60)
  })
  it('treats windows, high sills, low lintels and exterior doors as walls', () => {
    const cases = [
      door('n', 300, 90, { kind: 'window', sill: 85, height: 120 }),
      door('n', 300, 90, { kind: 'window', sill: 0, height: 120 }),
      door('n', 300, 90, { kind: 'window', sill: 0, height: 215 }), // a floor-to-ceiling window is still glass
      door('n', 300, 90, { sill: 30 }),
      door('n', 300, 90, { height: 150 }),
      door('n', 300, 90, { exterior: true }),
    ]
    for (const o of cases) {
      const c = buildColliders(room({ openings: [o] }))
      expect(isTraversable(o)).toBe(false)
      expect(walk({ x: 400, y: 200 }, -Math.PI / 2, 3, c).y).toBeGreaterThan(100)
    }
  })
  it('walks through double doors and plain openings as well as single doors', () => {
    for (const kind of ['doubleDoor', 'opening', 'door']) {
      const c = buildColliders(room({ openings: [door('n', 300, 90, { kind })] }))
      expect(walk({ x: 400, y: 200 }, -Math.PI / 2, 3, c).y, kind).toBeLessThan(60)
    }
  })
  it('a door at the very end of a wall leaves the other part solid', () => {
    expect(solidSpans(600, [[-10, 80]])).toEqual([[80, 600]])
    expect(solidSpans(600, [[520, 700]])).toEqual([[0, 520]])
    expect(solidSpans(600, [[100, 190], [150, 250]])).toEqual([[0, 100], [250, 600]])
  })
  it('reversed walls (endpoint B first) put the doorway in the same place', () => {
    const base = room({ openings: [door('n', 300, 90)] })
    const flipped = { ...base, walls: base.walls.map((w) => (w.id === 'n' ? { ...w, a: w.b, b: w.a } : w)), openings: [door('n', 600 - 300, 90)] }
    const s = walk({ x: 400, y: 200 }, -Math.PI / 2, 3, buildColliders(flipped))
    expect(s.y).toBeLessThan(60)
  })
})

describe('furniture', () => {
  it('blocks rotated pieces by their true footprint, not a bounding box', () => {
    // a 200 x 40 shelf turned 45 degrees: its axis-aligned box would be ~170 square and fill the diagonal gaps
    const c = buildColliders(room({ items: [item('shelf', 400, 300, 45, 200, 40)] }))
    // walking along the shelf's own long axis from the corner area is blocked end-on
    const end = walk({ x: 250, y: 150 }, Math.PI / 4, 4, c)
    expect(clearance(end, c)).toBeGreaterThanOrEqual(R - 1e-3)
    expect(Math.hypot(end.x - 400, end.y - 300)).toBeGreaterThan(100)
    // a point in the bounding box corner (outside the true footprint) is walkable
    expect(clearance({ x: 400 - 70, y: 300 + 70 }, c)).toBeGreaterThan(75)
    // rotation 90 swaps width and depth
    const sofa = buildColliders(room({ items: [item('sofa', 400, 300, 90, 200, 90)] }))
    const sx = sofa.find((o) => o.id === 'item:sofa')!
    expect(Math.abs(sx.ux)).toBeLessThan(1e-9)
    expect(sx.hu).toBe(100)
    expect(clearance({ x: 400 + 45 + 30, y: 300 }, sofa)).toBeCloseTo(30, 6)
    expect(clearance({ x: 400, y: 300 + 100 + 30 }, sofa)).toBeCloseTo(30, 6)
  })
  it('walks around a sofa and keeps going', () => {
    const c = buildColliders(room({ items: [item('sofa', 400, 300, 90, 200, 90)] }))
    // head for the far wall straight through the sofa, steering round it by turning
    let s: WalkState = { x: 250, y: 300, heading: 0, pitch: 0 }
    for (let i = 0; i < 90; i++) s = stepWalk(s, { ...NO_KEYS, forward: true }, 1 / 60, c) // pushes against it
    expect(s.x).toBeLessThan(400 - 45 - R + 1)
    s = { ...s, heading: Math.PI / 2 }
    for (let i = 0; i < 120; i++) s = stepWalk(s, { ...NO_KEYS, forward: true }, 1 / 60, c) // down the side
    s = { ...s, heading: 0 }
    for (let i = 0; i < 180; i++) s = stepWalk(s, { ...NO_KEYS, forward: true }, 1 / 60, c)
    expect(s.x).toBeGreaterThan(500)
    expect(inside(s)).toBe(true)
  })
  it('ignores things walked over or hung above head height, and the artwork itself', () => {
    const c = buildColliders(room({
      items: [
        item('rug', 300, 300, 0, 200, 150, { height: 2 }), item('cabinet', 500, 300, 0, 60, 30, { elevation: 150 }),
        item('art', 400, 107, 0, 80, 3, { tag: 'wallsnap', elevation: 0, height: 120 }),
      ],
    }))
    expect(c.filter((o) => o.kind === 'furniture')).toHaveLength(0)
  })
})

describe('stairs and floor cut-outs', () => {
  const stair: StairInfo = { id: 's', x: 400, y: 300, rotation: 90, width: 60, steps: 8, treadDepth: 25, nosing: 0, cutOpening: true, wellGap: 10 }
  it('treats a stair on this floor as an obstacle sized by its run and width', () => {
    const c = buildColliders(room({ stairs: [stair] }))
    const o = c.find((x) => x.kind === 'stair')!
    expect([o.hu, o.hv]).toEqual([30, 100])
    expect(clearance({ x: 400 + 100 + 20, y: 300 }, c)).toBeCloseTo(20, 6)
    expect(clearance({ x: 400, y: 300 + 30 + 20 }, c)).toBeCloseTo(20, 6)
  })
  it('cuts a hole, with its well gap, where a stair from the floor below rises through this slab', () => {
    const c = buildColliders(room({ stairsBelow: [stair] }))
    const o = c.find((x) => x.kind === 'cutout')!
    expect([o.hu, o.hv]).toEqual([40, 110])
    const s = walk({ x: 250, y: 300 }, 0, 4, c)
    expect(s.x).toBeLessThan(400 - 110 - R + 1)
    expect(buildColliders(room({ stairsBelow: [{ ...stair, cutOpening: false }] })).some((x) => x.kind === 'cutout')).toBe(false)
  })
})

describe('movement', () => {
  const c = buildColliders(room())
  it('goes the same distance regardless of frame rate', () => {
    const a = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true }, 60)
    const b = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true }, 30)
    const d = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true }, 144)
    for (const s of [a, b, d]) expect(s.x - 200).toBeCloseTo(WALK_SPEED, 3)
  })
  it('a stalled frame is clamped, so a hitch never teleports', () => {
    const s = stepWalk({ x: 200, y: 300, heading: 0, pitch: 0 }, { ...NO_KEYS, forward: true }, 3, c)
    expect(s.x - 200).toBeCloseTo(WALK_SPEED * 0.05, 6)
  })
  it('diagonals are not faster; opposite keys cancel; shift is modestly faster', () => {
    const fwd = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true })
    const diag = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true, right: true } as never)
    expect(Math.hypot(diag.x - 200, diag.y - 300)).toBeCloseTo(fwd.x - 200, 3)
    const none = walk({ x: 200, y: 300 }, 0, 1, c, { forward: true, back: true } as never)
    expect(none.x).toBe(200)
    const fast = walk({ x: 200, y: 300 }, 0, 0.5, c, { forward: true, fast: true } as never)
    expect(fast.x - 200).toBeGreaterThan(WALK_SPEED * 0.5)
    expect(fast.x - 200).toBeLessThan(WALK_SPEED * 0.5 * 2)
  })
  it('strafes to the right of the view and moves back', () => {
    const r = walk({ x: 300, y: 300 }, 0, 0.5, c, { right: true } as never) // facing +x, right is +y on the plan
    expect(r.y).toBeGreaterThan(300)
    expect(r.x).toBeCloseTo(300, 6)
    const l = walk({ x: 300, y: 300 }, 0, 0.5, c, { left: true } as never)
    expect(l.y).toBeLessThan(300)
    expect(walk({ x: 300, y: 300 }, 0, 0.5, c, { back: true } as never).x).toBeLessThan(300)
  })
  it('mouse look turns and clamps the pitch', () => {
    const s = applyLook({ x: 0, y: 0, heading: 0, pitch: 0 }, 100, -50)
    expect(s.heading).toBeGreaterThan(0)
    expect(s.pitch).toBeGreaterThan(0)
    expect(applyLook(s, 0, -1e6).pitch).toBe(MAX_PITCH)
    expect(applyLook(s, 0, 1e6).pitch).toBe(-MAX_PITCH)
  })
  it('a refused move leaves the body where it was rather than inside a collider', () => {
    // pinched between two shapes with no room for the body
    const pinch = buildColliders(room({ items: [item('a', 400, 270, 0, 200, 20), item('b', 400, 330, 0, 200, 20)] }))
    const p = moveCircle({ x: 400, y: 300 }, { x: 5, y: 0 }, pinch)
    expect(clearance(p, pinch)).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(p.x)).toBe(true)
  })
})

describe('safe start', () => {
  const data = room({ items: [item('sofa', 400, 300, 90, 200, 90)] })
  const colliders = buildColliders(data)
  const walls = data.walls.map((w) => ({ a: w.a, b: w.b }))
  const art = { x: 400, y: 107.5 + 1.5 } // hung on the north wall's inner face
  const normal = { x: 0, y: 1 }
  it('starts 2.5 m in front of the artwork, at a clear spot, looking at it', () => {
    const r = findStart({ artwork: art, normal, colliders, walls })
    if (!r.ok) throw new Error(r.reason)
    expect(r.distanceCm).toBeGreaterThan(200)
    expect(r.distanceCm).toBeLessThan(300)
    expect(clearance({ x: r.state.x, y: r.state.y }, colliders)).toBeGreaterThanOrEqual(R)
    // forward points at the artwork
    const f = { x: Math.cos(r.state.heading), y: Math.sin(r.state.heading) }
    const to = { x: art.x - r.state.x, y: art.y - r.state.y }
    const l = Math.hypot(to.x, to.y)
    expect((f.x * to.x + f.y * to.y) / l).toBeGreaterThan(0.9999)
  })
  it('moves to the nearest valid spot when the preferred one is taken by furniture', () => {
    const blocked = buildColliders(room({ items: [item('big', 400, 357, 0, 200, 100)] })) // sits right on the 250 cm mark
    const r = findStart({ artwork: art, normal, colliders: blocked, walls })
    if (!r.ok) throw new Error(r.reason)
    expect(clearance({ x: r.state.x, y: r.state.y }, blocked)).toBeGreaterThanOrEqual(R)
  })
  it('never places the camera in another room or behind a wall', () => {
    // a partition 150 cm out from the artwork separates the room: the start must be on the artwork's side
    const split = room({ walls: [...room().walls, { id: 'p', a: { x: 100, y: 260 }, b: { x: 700, y: 260 }, thickness: 10 }] })
    const sc = buildColliders(split)
    const r = findStart({ artwork: art, normal, colliders: sc, walls: split.walls.map((w) => ({ a: w.a, b: w.b })) })
    if (!r.ok) throw new Error(r.reason)
    expect(r.state.y).toBeLessThan(255 - R)
  })
  it('reports a problem instead of guessing when there is no safe place', () => {
    const jam = buildColliders(room({ items: [item('wall-to-wall', 400, 300, 0, 600, 400, {})] }))
    const r = findStart({ artwork: art, normal, colliders: jam, walls })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no clear spot/i)
  })
  it('works from every wall direction: the artwork always ends up in front of the start', () => {
    for (const [ax, ay, nx, ny] of [[400, 109, 0, 1], [400, 491, 0, -1], [109, 300, 1, 0], [691, 300, -1, 0]] as const) {
      const r = findStart({ artwork: { x: ax, y: ay }, normal: { x: nx, y: ny }, colliders: buildColliders(room()), walls })
      expect(r.ok).toBe(true)
    }
  })
})

describe('switching floors', () => {
  it('each floor has its own colliders; a new floor starts from a fresh safe point', () => {
    const ground = room({ floorId: 'g', stairs: [{ id: 's', x: 400, y: 300, rotation: 0, width: 60, steps: 8, treadDepth: 25, nosing: 0, cutOpening: true, wellGap: 10 }] })
    const upper = room({ floorId: 'u', stairsBelow: ground.stairs, items: [item('bed', 250, 400, 0, 160, 200)] })
    const g = buildColliders(ground)
    const u = buildColliders(upper)
    expect(g.some((o) => o.kind === 'stair')).toBe(true)
    expect(u.some((o) => o.kind === 'cutout')).toBe(true)
    expect(u.some((o) => o.id === 'item:bed')).toBe(true)
    expect(g.some((o) => o.id === 'item:bed')).toBe(false)
    const start = (d: WalkData) => findStart({ artwork: { x: 400, y: 109 }, normal: { x: 0, y: 1 }, colliders: buildColliders(d), walls: d.walls.map((w) => ({ a: w.a, b: w.b })) })
    for (const d of [ground, upper]) {
      const r = start(d)
      expect(r.ok).toBe(true)
      if (r.ok) expect(clearance(r.state, buildColliders(d))).toBeGreaterThanOrEqual(R)
    }
  })
})

describe('pointer-lock lifecycle', () => {
  it('enter -> lock -> escape releases the pointer but stays in Walk; exit always leaves', () => {
    let p = walkPhase('off', 'enter')
    expect(p).toBe('ready')
    p = walkPhase(p, 'lock')
    expect(p).toBe('locked')
    p = walkPhase(p, 'escape')
    expect(p).toBe('ready')
    p = walkPhase(p, 'lock')
    expect(walkPhase(p, 'unlock')).toBe('ready')
    expect(walkPhase(p, 'exit')).toBe('off')
    expect(walkPhase('ready', 'exit')).toBe('off')
  })
  it('a lock that arrives after Walk was exited is ignored; escape when not locked does nothing', () => {
    expect(walkPhase('off', 'lock')).toBe('off')
    expect(walkPhase('off', 'escape')).toBe('off')
    expect(walkPhase('ready', 'escape')).toBe('ready')
    expect(walkPhase('locked', 'enter')).toBe('locked')
  })
})
