// Synthetic geometry for the mock gateway. It is NOT derived from any real project.
// Row shapes follow what FloorGen's list_entities returns (detail "full").
type Row = Record<string, unknown>

const wall = (id: string, a: [number, number], b: [number, number], thickness: number, height: number): Row => ({
  id, type: 'wall', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] },
  length_cm: Math.hypot(b[0] - a[0], b[1] - a[1]), thickness_cm: thickness, entity: { height },
})
const opening = (id: string, kind: string, wall_id: string, offset_cm: number, width_cm: number, sill: number, height: number, exterior = false): Row => ({
  id, type: 'opening', kind, wall_id, offset_cm, width_cm, rooms: exterior ? ['Room', 'exterior'] : [], entity: { sill, height },
})
const item = (id: string, x: number, y: number, rotation: number, width: number, depth: number, height: number, elevation = 0): Row => ({
  id, type: 'item', x, y, rotation, entity: { width, depth, height, elevation },
})
const stair = (id: string, x: number, y: number, rotation: number, width: number, steps: number, treadDepth: number): Row => ({
  id, type: 'stair', x, y, entity: { id, x, y, rotation, width, steps, treadDepth, nosing: 0, cutOpening: true, wellGap: 10 },
})
const room = (name: string, wall_ids: string[], x: number, y: number): Row => ({
  id: `room_${wall_ids[0]}`, type: 'room', key: wall_ids.join('|'), name, wall_ids, centroid: { x, y },
})

export const FLOORS = [
  { id: 'f_ground', name: 'Ground floor', kind: 'ground', height: 250 },
  { id: 'f_first', name: 'First floor', kind: 'upper', height: 250 },
]

export const ENTITIES: Record<string, Row[]> = {
  // One 700 cm north wall (reserved-wall rule) and a slanted east wall (non-axis-aligned geometry).
  f_ground: [
    wall('gs_north', [100, 100], [800, 100], 15, 250), wall('gs_east', [800, 100], [700, 500], 15, 250),
    wall('gs_south', [700, 500], [100, 500], 15, 250), wall('gs_west', [100, 500], [100, 100], 15, 250),
    room('Studio', ['gs_north', 'gs_east', 'gs_south', 'gs_west'], 425, 300),
    opening('go_door', 'door', 'gs_south', 150, 90, 0, 205),
    stair('gst_1', 250, 430, 90, 60, 8, 25), // a 200 cm run along x, 60 cm wide, centred at (250, 430)
  ],
  // Mixed wall directions: north and west run against the clockwise order of east and south.
  f_first: [
    wall('fl_north', [100, 100], [700, 100], 15, 250), wall('fl_east', [700, 100], [700, 500], 15, 250),
    wall('fl_south', [700, 500], [100, 500], 15, 250), wall('fl_west', [100, 100], [100, 500], 15, 250),
    room('Room A', ['fl_north', 'fl_east', 'fl_south', 'fl_west'], 400, 300),
    opening('fo_window', 'window', 'fl_north', 200, 120, 90, 120),
    opening('fo_door', 'door', 'fl_south', 150, 90, 0, 205, true),
    // A second room east of Room A, joined by a doorway in their shared wall, and a sofa and a narrow shelf in Room A.
    wall('fl_hn', [700, 100], [900, 100], 15, 250), wall('fl_he', [900, 100], [900, 500], 15, 250), wall('fl_hs', [900, 500], [700, 500], 15, 250),
    room('Hall', ['fl_east', 'fl_hn', 'fl_he', 'fl_hs'], 800, 300),
    opening('fo_pass', 'door', 'fl_east', 340, 90, 0, 205),
    item('furn_sofa', 400, 300, 90, 200, 90, 80), // 200 x 90, turned: 90 wide along x, 200 along y
    item('furn_rug', 250, 400, 0, 200, 150, 2), // a rug: walked over
    item('furn_lamp', 200, 200, 0, 40, 40, 30, 150), // hangs above head height: not an obstacle
  ],
}
