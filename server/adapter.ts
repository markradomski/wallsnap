import {
  facingRotation, flushPerp, planPoint, validate, wallCoords, wallFrame, type WallFrame,
} from '../src/geometry'
import type { ApplyResult, Artwork, FloorSummary, Opening, WallState } from '../src/types'
import {
  BoundaryError, arr, id, isRec, parseFloor, parseItem, parseOpening, parseRoom, parseWall, rec,
  type FloorRow, type ItemRow, type OpeningRow, type RoomRow, type WallRow,
} from './boundary'
import type { Gateway } from './gateway'

export class StaleError extends Error {}
export class ValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '))
  }
}

const TAG = 'wallsnap'
const CATALOG_ID = 'picture-large' // 100x3x70 cm catalogue picture, resized to the requested size
const CATALOG_DEPTH = 3
/** Heuristic for the reserved studio wall: ground-floor walls at least this long are not offered. */
const RESERVED_MIN_LENGTH = 650
/** Tolerances for read-back verification (cm). */
const VERIFY_TOL = 0.1
const FLUSH_TOL = 0.5

const side = (n: { x: number; y: number }) =>
  Math.abs(n.y) >= Math.abs(n.x) ? (n.y > 0 ? 'north' : 'south') : n.x > 0 ? 'west' : 'east'

interface FloorEntities {
  rev: number
  walls: WallRow[]
  openings: OpeningRow[]
  rooms: RoomRow[]
}

export class WallSnapAdapter {
  constructor(private gw: Gateway, private project: string) {}

  private async rows(floor: string, extra: Record<string, unknown> = {}) {
    const res = await this.gw.call('list_entities', {
      project: this.project, floor, detail: 'full', limit: 1000, type: ['room', 'wall', 'opening', 'item'], ...extra,
    })
    return { rev: res.rev, rows: arr(rec(res.data, 'data').rows, 'data.rows') }
  }

  private async floors(): Promise<FloorRow[]> {
    const res = await this.gw.call('list_floors', { project: this.project })
    return arr(rec(res.data, 'data').floors, 'data.floors').map(parseFloor)
  }

  private async floorEntities(floor: string): Promise<FloorEntities> {
    const { rev, rows } = await this.rows(floor)
    const ofType = (t: string) => rows.filter((r) => isRec(r) && r.type === t)
    return {
      rev,
      walls: ofType('wall').map(parseWall),
      openings: ofType('opening').map(parseOpening),
      rooms: ofType('room').map(parseRoom),
    }
  }

  async listFloors(): Promise<FloorSummary[]> {
    const out: FloorSummary[] = []
    for (const f of await this.floors()) {
      const e = await this.floorEntities(f.id)
      const walls = e.walls.flatMap((w) => {
        const room = e.rooms.find((r) => r.wallIds.includes(w.id))
        if (!room) return [] // a wall bounding no room has no face to hang on
        const frame = wallFrame(w.a, w.b, room.centroid)
        return [{
          id: w.id, length: frame.length, height: w.height,
          reserved: f.kind === 'ground' && frame.length >= RESERVED_MIN_LENGTH,
          label: `${room.name} — ${side(frame.normal)} wall, ${Math.round(frame.length)} cm`,
        }]
      })
      out.push({ id: f.id, name: f.name, walls })
    }
    return out
  }

  private async read(floorId: string, wallId: string) {
    id(floorId, 'floor id')
    id(wallId, 'wall id')
    const floor = (await this.floors()).find((f) => f.id === floorId)
    if (!floor) throw new ValidationError(['Unknown floor.'])
    const e = await this.floorEntities(floorId)
    const wall = e.walls.find((w) => w.id === wallId)
    if (!wall) throw new ValidationError(['Unknown wall.'])
    const room = e.rooms.find((r) => r.wallIds.includes(wallId))
    if (!room) throw new ValidationError(['This wall has no room-facing side.'])
    const frame = wallFrame(wall.a, wall.b, room.centroid)
    if (floor.kind === 'ground' && frame.length >= RESERVED_MIN_LENGTH) {
      throw new ValidationError(['This is the reserved painting wall and cannot be used for hanging artwork.'])
    }
    const openings: Opening[] = e.openings
      .filter((o) => o.wallId === wallId)
      .map((o) => ({ id: o.id, kind: o.kind, left: o.offset - o.width / 2, width: o.width, sill: o.sill, height: o.height }))
    // Existing WallSnap artwork lying flush on this wall.
    const tagged = (await this.rows(floorId, { type: ['item'], ids: [{ tag: TAG }] })).rows.map(parseItem)
    const item = tagged.find((it) => {
      const c = wallCoords(frame, it)
      return c.u > -2 && c.u < frame.length + 2 && Math.abs(c.perp - flushPerp(wall.thickness, it.depth)) < 3
    })
    return { rev: e.rev, wall, room, frame, openings, item }
  }

  private toArtwork(frame: WallFrame, item: ItemRow): Artwork {
    return { width: item.width, height: item.height, u: wallCoords(frame, item).u, v: item.elevation }
  }

  async loadWall(floorId: string, wallId: string): Promise<WallState> {
    const r = await this.read(floorId, wallId)
    return {
      rev: r.rev,
      wall: { id: wallId, floorId, length: r.frame.length, height: r.wall.height, openings: r.openings },
      artwork: r.item ? this.toArtwork(r.frame, r.item) : null,
    }
  }

  async apply(floorId: string, wallId: string, art: Artwork, expectedRev: number): Promise<ApplyResult> {
    const r = await this.read(floorId, wallId)
    if (r.rev !== expectedRev) throw new StaleError('The FloorGen project changed since you loaded this wall. Reload before applying.')
    const problems = validate({ length: r.frame.length, height: r.wall.height, openings: r.openings }, art)
    if (problems.length) throw new ValidationError(problems)

    const pos = planPoint(r.frame, art.u, flushPerp(r.wall.thickness, r.item?.depth ?? CATALOG_DEPTH))
    const fields = {
      x: pos.x, y: pos.y, rotation: facingRotation(r.frame.normal),
      width: art.width, height: art.height, elevation: art.v,
    }
    const base = { project: this.project, floor: floorId }
    let rev = r.rev
    let created = false

    if (r.item) {
      rev = (await this.gw.call('update_items', { ...base, id: r.item.id, ...fields, expected_rev: rev })).rev
    } else {
      created = true
      const placed = await this.gw.call('place_item', {
        ...base, catalog_id: CATALOG_ID, room: r.room.key, at: { x: pos.x, y: pos.y },
        rotation: fields.rotation, elevation: art.v, snap: false, name: 'WallSnap artwork', expected_rev: rev,
      })
      const itemId = id(rec(placed.data, 'place_item data').item_id, 'item_id')
      rev = (await this.gw.call('update_items', { ...base, id: itemId, ...fields, tag: TAG, expected_rev: placed.rev })).rev
    }

    // Success is reported only if a fresh read shows what was asked for.
    const back = await this.read(floorId, wallId)
    if (!back.item) throw new BoundaryError('Verification failed: the artwork was not found on the wall after saving.')
    const saved = this.toArtwork(back.frame, back.item)
    const perp = wallCoords(back.frame, back.item).perp - flushPerp(back.wall.thickness, back.item.depth)
    const off = (['width', 'height', 'u', 'v'] as const).filter((k) => Math.abs(saved[k] - art[k]) > VERIFY_TOL)
    if (off.length || Math.abs(perp) > FLUSH_TOL) {
      throw new BoundaryError(`Verification failed: FloorGen holds different ${off.join(', ') || 'wall-contact'} values than requested (rev ${rev}).`)
    }
    return { artwork: saved, rev: back.rev, created }
  }
}
