import type { Pt } from '../src/geometry'

/** Minimal runtime validation for data arriving from the MCP server (treated as untrusted). */
export class BoundaryError extends Error {}

type Rec = Record<string, unknown>

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

export function rec(v: unknown, what: string): Rec {
  if (!isRec(v)) throw new BoundaryError(`${what}: expected an object`)
  return v
}
export function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new BoundaryError(`${what}: expected an array`)
  return v
}
export function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BoundaryError(`${what}: expected a finite number`)
  return v
}
const positive = (v: unknown, what: string) => {
  const n = num(v, what)
  if (n <= 0) throw new BoundaryError(`${what}: expected a positive number`)
  return n
}
const nonNegative = (v: unknown, what: string) => {
  const n = num(v, what)
  if (n < 0) throw new BoundaryError(`${what}: expected a non-negative number`)
  return n
}
export function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 600) throw new BoundaryError(`${what}: expected a string`)
  return v
}
/** FloorGen ids and room keys: word characters, '-' and '|' only. */
export function id(v: unknown, what: string): string {
  const s = str(v, what)
  if (!/^[\w|-]+$/.test(s)) throw new BoundaryError(`${what}: malformed id`)
  return s
}
export function rev(v: unknown, what = 'rev'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new BoundaryError(`${what}: expected a revision number`)
  return v
}
function point(v: unknown, what: string): Pt {
  const r = rec(v, what)
  return { x: num(r.x, `${what}.x`), y: num(r.y, `${what}.y`) }
}

export interface FloorRow { id: string; name: string; kind: string; /** Storey height, cm. */ height: number }
export interface WallRow { id: string; a: Pt; b: Pt; thickness: number; height: number }
export interface OpeningRow { id: string; kind: string; wallId: string; offset: number; width: number; sill: number; height: number; /** Opens to the outside of the building. */ exterior?: boolean }
export interface RoomRow { key: string; name: string; wallIds: string[]; centroid: Pt }
export interface ItemRow { id: string; x: number; y: number; rotation: number; width: number; height: number; depth: number; elevation: number; /** #rrggbb, when FloorGen reports one. */ color?: string; tag?: string }
export interface StairRow { id: string; x: number; y: number; rotation: number; width: number; steps: number; treadDepth: number; nosing: number; cutOpening: boolean; wellGap: number }

export function parseFloor(v: unknown): FloorRow {
  const r = rec(v, 'floor')
  return { id: id(r.id, 'floor.id'), name: str(r.name, 'floor.name'), kind: str(r.kind, 'floor.kind'), height: positive(r.height, 'floor.height') }
}
export function parseWall(v: unknown): WallRow {
  const r = rec(v, 'wall')
  const e = rec(r.entity, 'wall.entity')
  return {
    id: id(r.id, 'wall.id'), a: point(r.a, 'wall.a'), b: point(r.b, 'wall.b'),
    thickness: positive(r.thickness_cm, 'wall.thickness'), height: positive(e.height, 'wall.height'),
  }
}
export function parseOpening(v: unknown): OpeningRow {
  const r = rec(v, 'opening')
  const e = rec(r.entity, 'opening.entity')
  return {
    id: id(r.id, 'opening.id'), kind: str(r.kind, 'opening.kind'), wallId: id(r.wall_id, 'opening.wall_id'),
    offset: num(r.offset_cm, 'opening.offset'), width: positive(r.width_cm, 'opening.width'),
    sill: nonNegative(e.sill, 'opening.sill'), height: positive(e.height, 'opening.height'),
    exterior: Array.isArray(r.rooms) && r.rooms.includes('exterior'),
  }
}
export function parseRoom(v: unknown): RoomRow {
  const r = rec(v, 'room')
  return {
    key: id(r.key, 'room.key'), name: str(r.name, 'room.name'),
    wallIds: arr(r.wall_ids, 'room.wall_ids').map((w) => id(w, 'room.wall_ids[]')),
    centroid: point(r.centroid, 'room.centroid'),
  }
}
export function parseItem(v: unknown): ItemRow {
  const r = rec(v, 'item')
  const e = rec(r.entity, 'item.entity')
  return {
    id: id(r.id, 'item.id'), x: num(r.x, 'item.x'), y: num(r.y, 'item.y'), rotation: num(r.rotation, 'item.rotation'),
    width: positive(e.width, 'item.width'), height: positive(e.height, 'item.height'),
    depth: positive(e.depth, 'item.depth'), elevation: num(e.elevation, 'item.elevation'),
    color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color.toLowerCase() : undefined,
    tag: typeof r.tag === 'string' ? r.tag.slice(0, 60) : undefined,
  }
}
export function parseStair(v: unknown): StairRow {
  const r = rec(v, 'stair')
  const e = rec(r.entity, 'stair.entity')
  return {
    id: id(r.id, 'stair.id'), x: num(e.x ?? r.x, 'stair.x'), y: num(e.y ?? r.y, 'stair.y'), rotation: num(e.rotation ?? 0, 'stair.rotation'),
    width: positive(e.width, 'stair.width'), steps: positive(e.steps, 'stair.steps'), treadDepth: positive(e.treadDepth, 'stair.treadDepth'),
    nosing: nonNegative(e.nosing ?? 0, 'stair.nosing'), cutOpening: e.cutOpening === true, wellGap: nonNegative(e.wellGap ?? 0, 'stair.wellGap'),
  }
}
