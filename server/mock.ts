import { isRec } from './boundary'
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

  /** Test hook: simulates someone else editing the project. */
  touch() {
    this.rev++
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
        const types = Array.isArray(a.type) ? a.type : ['room', 'wall', 'opening', 'item']
        const rows: unknown[] = tag
          ? this.items.filter((i) => i.floor === floor && i.tag === tag).map(toRow)
          : [
              ...(ENTITIES[floor] ?? []).filter((e) => types.includes(e.type)),
              ...(types.includes('item') ? this.items.filter((i) => i.floor === floor).map(toRow) : []),
            ]
        return { rev: this.rev, data: { rows: structuredClone(rows) } }
      }
      case 'place_item': {
        this.checkRev(tool, a)
        const at = isRec(a.at) ? a.at : {}
        const item: MockItem = {
          id: `i_mock${++this.seq}`, floor, x: this.num(tool, at.x, 'x'), y: this.num(tool, at.y, 'y'),
          rotation: this.num(tool, a.rotation ?? 0, 'rotation'), width: 100, height: 70, depth: 3,
          elevation: this.num(tool, a.elevation ?? 0, 'elevation'),
        }
        this.items.push(item)
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
      default:
        return this.fail(tool, 'not implemented by the mock')
    }
  }
}
