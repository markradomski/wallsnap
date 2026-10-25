import { beforeEach, describe, expect, it } from 'vitest'
import { localPlanItem } from '../src/viewer3d/plan'
import { WallSnapAdapter } from './adapter'
import { MockGateway } from './mock'

let adapter: WallSnapAdapter
beforeEach(() => {
  adapter = new WallSnapAdapter(new MockGateway(), 'mock-project')
})

/**
 * The 3D preview shows an UNSAVED edit using the client-side conversion (localPlanItem). Apply then asks FloorGen to place the
 * artwork. For the preview to be trustworthy these must agree for every wall direction: previewed position == saved position.
 */
describe('previewed placement equals the placement FloorGen saves', () => {
  const cases: [string, string, string, { u: number; v: number; width: number; height: number }][] = [
    ['first', 'fl_north', 'north wall (A west)', { u: 450, v: 150, width: 80, height: 50 }], // clear of the window
    ['first', 'fl_south', 'south wall (A east, reversed)', { u: 300, v: 120, width: 70, height: 45 }],
    ['first', 'fl_west', 'west wall', { u: 200, v: 100, width: 60, height: 60 }],
    ['first', 'fl_east', 'east wall', { u: 120, v: 90, width: 90, height: 40 }],
    ['ground', 'gs_east', 'slanted wall', { u: 200, v: 100, width: 50, height: 40 }],
  ]
  it.each(cases)('%s / %s: %s', async (floorKey, wallId, _label, art) => {
    const floorId = floorKey === 'first' ? 'f_first' : 'f_ground'
    const before = await adapter.planContext(floorId, wallId)
    const previewed = localPlanItem(before, art) // what the 3D view draws for the unsaved edit
    const s = await adapter.loadWall(floorId, wallId)
    const saved = await adapter.apply(floorId, wallId, art, s.rev)
    const after = await adapter.planContext(floorId, wallId, saved.artworkId)
    const holds = after.item!
    expect(previewed.x).toBeCloseTo(holds.x, 9)
    expect(previewed.y).toBeCloseTo(holds.y, 9)
    expect(previewed.rotation).toBeCloseTo(holds.rotation, 2) // FloorGen rotation is stored to 0.001 degree
    expect([previewed.width, previewed.height, previewed.elevation, previewed.depth]).toEqual([holds.width, holds.height, holds.elevation, holds.depth])
  })
})
