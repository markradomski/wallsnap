// Synthetic geometry for the mock gateway. It is NOT derived from any real project.
// Row shapes follow what FloorGen's list_entities returns (detail "full").
type Row = Record<string, unknown>

const wall = (id: string, a: [number, number], b: [number, number], thickness: number, height: number): Row => ({
  id, type: 'wall', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] },
  length_cm: Math.hypot(b[0] - a[0], b[1] - a[1]), thickness_cm: thickness, entity: { height },
})
const opening = (id: string, kind: string, wall_id: string, offset_cm: number, width_cm: number, sill: number, height: number): Row => ({
  id, type: 'opening', kind, wall_id, offset_cm, width_cm, entity: { sill, height },
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
  ],
  // Mixed wall directions: north and west run against the clockwise order of east and south.
  f_first: [
    wall('fl_north', [100, 100], [700, 100], 15, 250), wall('fl_east', [700, 100], [700, 500], 15, 250),
    wall('fl_south', [700, 500], [100, 500], 15, 250), wall('fl_west', [100, 100], [100, 500], 15, 250),
    room('Room A', ['fl_north', 'fl_east', 'fl_south', 'fl_west'], 400, 300),
    opening('fo_window', 'window', 'fl_north', 200, 120, 90, 120),
    opening('fo_door', 'door', 'fl_south', 150, 90, 0, 205),
  ],
}
