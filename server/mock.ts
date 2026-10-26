import { flushPerp, planPoint, facingRotation, wallFrame } from '../src/geometry'
import { isRec, parseRoom, parseWall } from './boundary'
import { ENTITIES, FLOORS } from './fixture'
import { GatewayError, type Gateway, type ToolResult } from './gateway'

interface MockItem {
  id: string
  floor: string
  x: number
  y: number
  rotation: number
  tag?: string
  width: number
  height: number
  depth: number
  elevation: number
}

const toRow = (i: MockItem) => ({
  id: i.id, type: 'item', x: i.x, y: i.y, rotation: i.rotation, tag: i.tag,
  entity: { width: i.width, height: i.height, depth: i.depth, elevation: i.elevation },
})

/** In-memory stand-in for the FloorGen tools WallSnap uses. NOT a FloorGen integration. */
export class MockGateway implements Gateway {
  readonly kind = 'mock' as const
  private rev = 1000
  private items: MockItem[] = []
  private seq = 0

  private hiddenWalls = new Set<string>()

  /** Test hook: simulates someone else editing the project. */
  touch() {
    this.rev++
  }

  /** Test hooks: edits made directly in FloorGen, outside WallSnap. Each one bumps the project revision. */
  moveItem(id: string, to: { x?: number; y?: number; rotation?: number }) {
    Object.assign(this.item(id), to)
    this.rev++
  }
  resizeItem(id: string, to: { width?: number; height?: number; elevation?: number }) {
    Object.assign(this.item(id), to)
    this.rev++
  }
  deleteItem(id: string) {
    this.item(id)
    this.items = this.items.filter((i) => i.id !== id)
    this.rev++
  }
  hideWall(id: string) {
    this.hiddenWalls.add(id)
    this.rev++
  }
  private item(id: string): MockItem {
    return this.items.find((i) => i.id === id) ?? this.fail('test hook', `no item ${id}`)
  }

  private fail(tool: string, msg: string): never {
    throw new GatewayError(msg, tool)
  }

  private num(tool: string, v: unknown, what: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(tool, `bad ${what}`)
    return v
  }

  private checkRev(tool: string, a: Record<string, unknown>) {
    if (a.expected_rev !== undefined && a.expected_rev !== this.rev) this.fail(tool, 'REV_CONFLICT: project changed')
  }

  async call(tool: string, a: Record<string, unknown>): Promise<ToolResult> {
    const floor = String(a.floor ?? '')
    switch (tool) {
      case 'list_floors':
        return { rev: this.rev, data: { floors: FLOORS } }
      case 'list_entities': {
        const ids = Array.isArray(a.ids) ? a.ids : []
        const first: unknown = ids[0]
        const tag = isRec(first) ? first.tag : undefined
        const wanted = typeof first === 'string' ? first : undefined
        const types = Array.isArray(a.type) ? a.type : ['room', 'wall', 'opening', 'item']
        const rows: unknown[] = wanted
          ? this.items.filter((i) => i.floor === floor && i.id === wanted).map(toRow)
          : tag
          ? this.items.filter((i) => i.floor === floor && i.tag === tag).map(toRow)
          : [
              ...(ENTITIES[floor] ?? []).filter((e) => types.includes(e.type) && !this.hiddenWalls.has(String(e.id)) && (e.type !== 'item' || types.includes('wall'))), // fixed furniture only in whole-floor reads, never in artwork lookups
              ...(types.includes('item') ? this.items.filter((i) => i.floor === floor).map(toRow) : []),
            ]
        return { rev: this.rev, data: { rows: structuredClone(rows) } }
      }
      case 'place_on_wall': {
        this.checkRev(tool, a)
        const rows = ENTITIES[floor] ?? []
        const wall = parseWall(rows.find((r) => r.id === a.wall_id) ?? this.fail(tool, 'no such wall'))
        const room = rows.map((r) => (r.type === 'room' ? parseRoom(r) : null)).find((r) => r?.key === a.face_room)
        if (!room) this.fail(tool, 'no such room')
        const frame = wallFrame(wall.a, wall.b, room.centroid)
        const offset = this.num(tool, a.offset, 'offset')
        const elevation = this.num(tool, a.elevation, 'elevation')
        const existing = typeof a.item_id === 'string' ? this.items.find((i) => i.id === a.item_id) : undefined
        if (typeof a.item_id === 'string' && !existing) this.fail(tool, `no item ${a.item_id}`)
        const item: MockItem = existing ?? {
          id: `i_mock${++this.seq}`, floor, x: 0, y: 0, rotation: 0, width: 100, height: 70, depth: 3, elevation: 0,
        }
        // Like FloorGen, validate against the item's CURRENT size, not a size that is about to be set.
        if (offset - item.width / 2 < 0 || offset + item.width / 2 > frame.length) this.fail(tool, 'item would overhang the wall')
        if (elevation + item.height > wall.height) {
          throw new GatewayError(
            `The item is ${item.height} cm tall; at ${elevation} cm up it would reach ${elevation + item.height} cm but the wall is ${wall.height} cm high. Hint: Lower the elevation or pick a smaller item.`,
            tool, 'VALIDATION_FAILED',
          )
        }
        const p = planPoint(frame, offset, flushPerp(wall.thickness, item.depth))
        Object.assign(item, { x: p.x, y: p.y, rotation: facingRotation(frame.normal), elevation })
        if (!existing) this.items.push(item)
        this.rev++
        return { rev: this.rev, data: { item_id: item.id } }
      }
      case 'update_items': {
        this.checkRev(tool, a)
        const it = this.items.find((i) => i.id === a.id) ?? this.fail(tool, `no item ${String(a.id)}`)
        for (const k of ['x', 'y', 'rotation', 'width', 'height', 'elevation'] as const) {
          if (a[k] !== undefined) it[k] = this.num(tool, a[k], k)
        }
        if (typeof a.tag === 'string') it.tag = a.tag
        this.rev++
        return { rev: this.rev, data: { item_ids: [it.id] } }
      }
      case 'soft_delete': {
        this.checkRev(tool, a)
        const wanted = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string') : []
        const gone = this.items.filter((i) => wanted.includes(i.id))
        if (!gone.length) this.fail(tool, 'nothing to delete')
        this.items = this.items.filter((i) => !wanted.includes(i.id))
        this.rev++
        return { rev: this.rev, data: { trash_ids: gone.map((i) => `tr_${i.id}`) } }
      }
      default:
        return this.fail(tool, 'not implemented by the mock')
    }
  }
}
