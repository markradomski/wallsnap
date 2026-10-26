import { flushPerp, offWallReasons, validate, wallCoords, wallFrame, type WallFrame } from '../src/geometry'
import type { ApplyResult, Artwork, FloorSummary, Opening, PlanContext, WalkData, WallState } from '../src/types'
import {
  BoundaryError, arr, id, isRec, parseFloor, parseItem, parseOpening, parseRoom, parseStair, parseWall, rec,
  type FloorRow, type ItemRow, type OpeningRow, type RoomRow, type WallRow,
} from './boundary'
import { GatewayError, type Gateway } from './gateway'

export class StaleError extends Error {}
/** A multi-step save stopped part-way: the message says exactly what FloorGen already holds. */
export class PartialWriteError extends Error {}
/** The wall or the saved artwork no longer exists in FloorGen. Never answered with stale or invented data. */
export class MissingError extends Error {
  constructor(message: string, readonly code: 'wall_missing' | 'artwork_missing') {
    super(message)
  }
}
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

  private async floorsWithRev(): Promise<{ rev: number; floors: FloorRow[] }> {
    const res = await this.gw.call('list_floors', { project: this.project })
    return { rev: res.rev, floors: arr(rec(res.data, 'data').floors, 'data.floors').map(parseFloor) }
  }

  private async floors(): Promise<FloorRow[]> {
    return (await this.floorsWithRev()).floors
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

  /**
   * One consistent snapshot of a wall. It is assembled from several FloorGen reads, so every read must report the same
   * project revision; if the project changed part-way the snapshot is re-read, and given up on after a few tries.
   * With `itemId` the saved artwork is looked up by its persistent id (it may no longer be on the wall);
   * without it, a WallSnap artwork lying flush on this wall is used.
   */
  private async read(floorId: string, wallId: string, itemId?: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.readOnce(floorId, wallId, itemId)
      if (r.revs.every((x) => x === r.revs[0])) return { ...r, rev: r.revs[0] }
    }
    throw new StaleError('FloorGen kept changing while WallSnap was reading it. Try again in a moment.')
  }

  private async readOnce(floorId: string, wallId: string, itemId?: string) {
    id(floorId, 'floor id')
    id(wallId, 'wall id')
    if (itemId) id(itemId, 'item id')
    const fl = await this.floorsWithRev()
    const floor = fl.floors.find((f) => f.id === floorId)
    if (!floor) throw new ValidationError(['Unknown floor.'])
    const e = await this.floorEntities(floorId)
    const wall = e.walls.find((w) => w.id === wallId)
    if (!wall) throw new MissingError('This wall is no longer available in FloorGen.', 'wall_missing')
    const room = e.rooms.find((r) => r.wallIds.includes(wallId))
    if (!room) throw new ValidationError(['This wall has no room-facing side.'])
    const frame = wallFrame(wall.a, wall.b, room.centroid)
    if (floor.kind === 'ground' && frame.length >= RESERVED_MIN_LENGTH) {
      throw new ValidationError(['This is the reserved painting wall and cannot be used for hanging artwork.'])
    }
    const openings: Opening[] = e.openings
      .filter((o) => o.wallId === wallId)
      .map((o) => ({ id: o.id, kind: o.kind, left: o.offset - o.width / 2, width: o.width, sill: o.sill, height: o.height }))

    let item: ItemRow | undefined
    let itemRev: number
    if (itemId) {
      const found = await this.rows(floorId, { type: ['item'], ids: [itemId] })
      itemRev = found.rev
      item = found.rows.filter((r) => isRec(r) && r.type === 'item').map(parseItem).find((it) => it.id === itemId)
      if (!item) {
        throw new MissingError('The artwork no longer exists in FloorGen (it may have been deleted). Select the wall again to start a new one.', 'artwork_missing')
      }
    } else {
      // Existing WallSnap artwork lying flush on this wall.
      // FloorGen answers NOT_FOUND (not an empty list) when nothing on the floor carries the tag yet.
      const tagged = await this.rows(floorId, { type: ['item'], ids: [{ tag: TAG }] }).catch((e: unknown) => {
        if (e instanceof GatewayError && e.code === 'NOT_FOUND') return { rev: fl.rev, rows: [] as unknown[] } // the snapshot's own revision stands in; the read is re-checked for consistency
        throw e
      })
      itemRev = tagged.rev
      item = tagged.rows.map(parseItem).find((it) => {
        const c = wallCoords(frame, it)
        return c.u > -2 && c.u < frame.length + 2 && Math.abs(c.perp - flushPerp(wall.thickness, it.depth)) < 3
      })
    }
    const offWall = item ? offWallReasons(frame, wall.thickness, item) : []
    return { revs: [fl.rev, e.rev, itemRev], wall, room, frame, openings, item, offWall, floors: fl.floors }
  }

  /**
   * Plan-space geometry for the 3D preview: floors and heights, this wall's endpoints, thickness and room-facing normal, and
   * the saved artwork's raw plan coordinates. Read-only, and from one consistent snapshot like every other read.
   */
  async planContext(floorId: string, wallId: string, itemId?: string): Promise<PlanContext> {
    const r = await this.read(floorId, wallId, itemId)
    const at = r.floors.findIndex((f) => f.id === floorId)
    const it = r.item
    return {
      rev: r.rev,
      floors: r.floors.map((f) => ({ id: f.id, name: f.name, height: f.height })),
      floorId,
      baseCm: r.floors.slice(0, at).reduce((sum, f) => sum + f.height, 0),
      wall: { id: wallId, a: r.wall.a, b: r.wall.b, length: r.frame.length, height: r.wall.height, thickness: r.wall.thickness, normal: r.frame.normal },
      item: it ? { id: it.id, x: it.x, y: it.y, rotation: it.rotation, width: it.width, height: it.height, depth: it.depth, elevation: it.elevation, color: it.color ?? '#4b5a70' } : null,
    }
  }

  /**
   * What Walk mode collides with on one storey. Read-only; every part comes from the same project revision (re-read if it
   * changes part-way). Furniture and stairs are the authoritative FloorGen objects, never reconstructed from the 3D export.
   */
  async walkData(floorId: string): Promise<WalkData> {
    id(floorId, 'floor id')
    for (let attempt = 0; attempt < 3; attempt++) {
      const fl = await this.floorsWithRev()
      const at = fl.floors.findIndex((f) => f.id === floorId)
      if (at < 0) throw new ValidationError(['Unknown floor.'])
      const types = ['wall', 'opening', 'item', 'stair']
      const here = await this.rows(floorId, { type: types })
      const below = at > 0 ? await this.rows(fl.floors[at - 1].id, { type: ['stair'] }) : null
      if (here.rev !== fl.rev || (below && below.rev !== fl.rev)) continue
      const ofType = (rows: unknown[], t: string) => rows.filter((r) => isRec(r) && r.type === t)
      return {
        rev: fl.rev,
        floorId,
        baseCm: fl.floors.slice(0, at).reduce((sum, f) => sum + f.height, 0),
        walls: ofType(here.rows, 'wall').map(parseWall).map((w) => ({ id: w.id, a: w.a, b: w.b, thickness: w.thickness })),
        openings: ofType(here.rows, 'opening').map(parseOpening).map((o) => ({
          id: o.id, wallId: o.wallId, kind: o.kind, offset: o.offset, width: o.width, sill: o.sill, height: o.height, exterior: o.exterior === true,
        })),
        items: ofType(here.rows, 'item').map(parseItem).map((i) => ({
          id: i.id, x: i.x, y: i.y, rotation: i.rotation, width: i.width, depth: i.depth, height: i.height, elevation: i.elevation, tag: i.tag,
        })),
        stairs: ofType(here.rows, 'stair').map(parseStair),
        stairsBelow: below ? ofType(below.rows, 'stair').map(parseStair) : [],
      }
    }
    throw new StaleError('FloorGen kept changing while WallSnap was reading it. Try again in a moment.')
  }

  private toArtwork(frame: WallFrame, item: ItemRow): Artwork {
    return { width: item.width, height: item.height, u: wallCoords(frame, item).u, v: item.elevation }
  }

  /**
   * Current state of a wall from FloorGen. Read-only: it never creates, resizes or moves anything. With `itemId` (Reload)
   * the known artwork is read back by id; if it is no longer on this wall the answer says so and carries no position.
   */
  async loadWall(floorId: string, wallId: string, itemId?: string): Promise<WallState> {
    const r = await this.read(floorId, wallId, itemId)
    const wall = { id: wallId, floorId, length: r.frame.length, height: r.wall.height, openings: r.openings }
    if (r.item && r.offWall.length) {
      return {
        rev: r.rev, wall, artwork: null, artworkId: r.item.id,
        detached: {
          message: 'Artwork is no longer positioned on this wall.', reasons: r.offWall,
          width: r.item.width, height: r.item.height, elevation: r.item.elevation,
        },
      }
    }
    return {
      rev: r.rev, wall, detached: null,
      artwork: r.item ? this.toArtwork(r.frame, r.item) : null,
      artworkId: r.item?.id ?? null,
    }
  }

  async apply(floorId: string, wallId: string, art: Artwork, expectedRev: number, knownItemId?: string | null): Promise<ApplyResult> {
    // With a known item id, that very object is updated (even if it was dragged off the wall): never a duplicate.
    const r = await this.read(floorId, wallId, knownItemId ?? undefined)
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
    const back = await this.read(floorId, wallId, itemId)
    if (!back.item || back.offWall.length) {
      throw new BoundaryError('Verification failed: the artwork was not found hanging on the wall after saving.')
    }
    const saved = this.toArtwork(back.frame, back.item)
    const perp = wallCoords(back.frame, back.item).perp - flushPerp(back.wall.thickness, back.item.depth)
    const off = (['width', 'height', 'u', 'v'] as const).filter((k) => Math.abs(saved[k] - art[k]) > VERIFY_TOL)
    if (off.length || Math.abs(perp) > FLUSH_TOL) {
      throw new BoundaryError(`Verification failed: FloorGen holds different ${off.join(', ') || 'wall-contact'} values than requested (rev ${rev}).`)
    }
    return { artwork: saved, artworkId: itemId, rev: back.rev, created }
  }
}
