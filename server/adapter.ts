import { flushPerp, validate, wallCoords, wallFrame, type WallFrame } from '../src/geometry'
import type { ApplyResult, Artwork, FloorSummary, Opening, WallState } from '../src/types'
import {
  BoundaryError, arr, id, isRec, parseFloor, parseItem, parseOpening, parseRoom, parseWall, rec,
  type FloorRow, type ItemRow, type OpeningRow, type RoomRow, type WallRow,
} from './boundary'
import type { Gateway } from './gateway'

export class StaleError extends Error {}
/** A multi-step save stopped part-way: the message says exactly what FloorGen already holds. */
export class PartialWriteError extends Error {}
export class ValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '))
  }
}

const TAG = 'wallsnap'
const CATALOG_ID = 'picture-large' // 100x3x70 cm catalogue picture, resized to the requested size
const CATALOG_WIDTH = 100
const CATALOG_HEIGHT = 70
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

    const base = { project: this.project, floor: floorId }
    const hang = { wall_id: wallId, face_room: r.room.key }
    // place_on_wall validates the item's CURRENT size against the wall, so the size must be right before the
    // final move: (1) a new catalogue picture (100x70) is hung at a pose where it fits, (2) resize,
    // (3) move to the exact u/v. An existing item is simply resized, then moved.
    let rev = r.rev
    let created = false
    let itemId: string
    let at = { offset: art.u, elevation: art.v }
    // What FloorGen already holds if a later step fails, so the error can describe the real saved state.
    const done: string[] = []
    let step = 'create'
    const partial = (e: unknown): never => {
      if (done.length === 0 || e instanceof StaleError) throw e
      const reason = e instanceof Error ? e.message : String(e)
      const state = created
        ? 'Reload to see the actual state; the new artwork now exists in FloorGen.'
        : 'Reload to see the actual state; FloorGen holds the changes below.'
      throw new PartialWriteError(
        `Partially saved: ${done.join(', then ')}, but ${step === 'resize' ? 'resizing' : 'moving it to the requested position'} failed (${reason}). ${state}`,
      )
    }

    try {
      if (r.item) {
        itemId = r.item.id
      } else {
        created = true
        at = {
          offset: Math.min(Math.max(art.u, CATALOG_WIDTH / 2), r.frame.length - CATALOG_WIDTH / 2),
          elevation: Math.min(art.v, Math.max(0, r.wall.height - CATALOG_HEIGHT)),
        }
        const placed = await this.gw.call('place_on_wall', {
          ...base, ...hang, catalog_id: CATALOG_ID, ...at, name: 'WallSnap artwork', expected_rev: rev,
        })
        itemId = id(rec(placed.data, 'place_on_wall data').item_id, 'item_id')
        rev = placed.rev
        done.push(`a new ${CATALOG_WIDTH}×${CATALOG_HEIGHT} cm placeholder artwork was created on the wall`)
      }
      step = 'resize'
      rev = (await this.gw.call('update_items', {
        ...base, id: itemId, width: art.width, height: art.height, tag: TAG, expected_rev: rev,
      })).rev
      done.push(`it was resized to ${art.width}×${art.height} cm`)
      step = 'move'
      if (!created || at.offset !== art.u || at.elevation !== art.v) {
        rev = (await this.gw.call('place_on_wall', { ...base, ...hang, item_id: itemId, offset: art.u, elevation: art.v, expected_rev: rev })).rev
      }
    } catch (e) {
      return partial(e)
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
