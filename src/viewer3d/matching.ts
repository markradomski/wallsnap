/**
 * Which solid in the exported model is the generic stand-in for the artwork being edited? FloorGen merges all furniture of a
 * floor into one mesh with no item ids, so this is decided from geometry alone, deterministically, and never guesses:
 * when the answer is not clear the model is left untouched and the caller shows a warning instead.
 */
import { flushPerp, wallCoords, type WallFrame } from '../geometry'
import { CM, boxError, expectedAabbCm, type Aabb, type PlanItem } from './transform'
import type { Solid } from './solids'

export type MatchStatus =
  /** The saved FloorGen item's exact box is in the model: the model is current for this artwork. */
  | 'exact'
  /** No exact box, but exactly one generic-coloured solid hangs on this wall: the artwork moved or changed since export. */
  | 'stale'
  /** Several generic-coloured solids hang on this wall and none is exact: not safe to pick one. */
  | 'ambiguous'
  /** Nothing in the model corresponds (added or moved elsewhere after the export). */
  | 'none'
  /** The artwork has no saved FloorGen item yet, so the model cannot contain its stand-in. */
  | 'unsaved'

export interface MatchResult {
  status: MatchStatus
  /** Index into the solids passed in, when there is something to hide. */
  solid?: number
  /** For 'exact': largest per-axis difference, in mm. */
  errorMm?: number
  /** How many generic-coloured solids hang on this wall. */
  candidates: number
}

/** Exact-match tolerance (cm): FloorGen rounds placement to 0.1 cm and glTF stores float32, so ~1 mm is a match. */
export const EXACT_TOL_CM = 0.1
/** How far (cm) a solid's centre may sit from the wall face and still count as hanging on this wall. */
export const WALL_TOL_CM = 1

export interface WallContext {
  frame: WallFrame
  thickness: number
  /** Height of the selected floor's base and of its walls, cm. */
  baseCm: number
  wallHeightCm: number
}

const centre = (b: Aabb): { x: number; y: number } => ({ x: ((b.min[0] + b.max[0]) / 2), y: ((b.min[2] + b.max[2]) / 2) })

/** Solids in the model are in metres; matching works in plan centimetres. */
const toCm = (b: Aabb): Aabb => ({ min: b.min.map((n) => n / CM) as Aabb['min'], max: b.max.map((n) => n / CM) as Aabb['max'] })

export function matchGenericArtwork(solids: Solid[], saved: PlanItem | null, wall: WallContext): MatchResult {
  if (!saved) return { status: 'unsaved', candidates: 0 }
  const boxes = solids.map((s) => toCm(s.box))

  // Candidates: generic solids hanging on THIS wall (plane, extent along it, and this floor).
  const candidates: number[] = []
  boxes.forEach((b, i) => {
    const c = centre(b)
    const at = wallCoords(wall.frame, { x: c.x, y: c.y })
    const onFloor = b.min[1] >= wall.baseCm - 0.5 && b.max[1] <= wall.baseCm + wall.wallHeightCm + 0.5
    const onPlane = Math.abs(at.perp - flushPerp(wall.thickness, saved.depth)) <= WALL_TOL_CM
    if (onFloor && onPlane && at.u >= -WALL_TOL_CM && at.u <= wall.frame.length + WALL_TOL_CM) candidates.push(i)
  })

  // Exact: the box the saved item predicts.
  const expected = expectedAabbCm(saved, wall.baseCm)
  const errors = boxes.map((b) => boxError(b, expected))
  const best = errors.reduce((m, e, i) => (e < errors[m] ? i : m), 0)
  const exact = errors.filter((e) => e <= EXACT_TOL_CM)
  if (exact.length === 1 && errors[best] <= EXACT_TOL_CM) {
    return { status: 'exact', solid: best, errorMm: errors[best] * 10, candidates: candidates.length }
  }
  if (exact.length > 1) return { status: 'ambiguous', candidates: candidates.length } // identical boxes: cannot tell them apart

  if (candidates.length === 1) return { status: 'stale', solid: candidates[0], candidates: 1 }
  if (candidates.length > 1) return { status: 'ambiguous', candidates: candidates.length }
  return { status: 'none', candidates: 0 }
}

export interface MatchEntry {
  id: string
  saved: PlanItem
  wall: WallContext
  /** Indices of the solids that have this artwork's colour; all solids when omitted. */
  allowed?: number[]
}

/**
 * Match several saved artworks against the same model. Exact matches are settled first and claim their solid, so a solid
 * can never be hidden for two artworks and an artwork's neighbours on the same wall are not mistaken for its stale
 * stand-in; then the rest are matched (stale / ambiguous / none) among the solids still unclaimed. Deterministic: entries
 * are processed in the order given. Returns the result per artwork id, with `solid` indexing the solids passed in.
 */
export function matchAllArtworks(solids: Solid[], entries: MatchEntry[]): Map<string, MatchResult> {
  const out = new Map<string, MatchResult>()
  const claimed = new Set<number>()
  const run = (e: MatchEntry) => {
    const idx = (e.allowed ?? solids.map((_, i) => i)).filter((i) => !claimed.has(i))
    const r = matchGenericArtwork(idx.map((i) => solids[i]), e.saved, e.wall)
    return r.solid === undefined ? r : { ...r, solid: idx[r.solid] }
  }
  for (const e of entries) {
    const r = run(e)
    if (r.status === 'exact') {
      claimed.add(r.solid!)
      out.set(e.id, r)
    }
  }
  for (const e of entries) {
    if (out.has(e.id)) continue
    const r = run(e)
    if (r.solid !== undefined) claimed.add(r.solid)
    out.set(e.id, r)
  }
  return out
}

export function describeMatch(r: MatchResult): string | null {
  switch (r.status) {
    case 'exact':
    case 'unsaved':
      return null
    case 'stale':
      return 'The 3D model was exported before this artwork changed in FloorGen. Its old placeholder is hidden; re-export the model to refresh the rest.'
    case 'ambiguous':
      return `The model has ${r.candidates} placeholder artworks on this wall, so WallSnap cannot tell which one is this artwork and has left them all in place. Re-export the model after saving.`
    case 'none':
      return 'This artwork is not in the 3D model (it was added or moved after the export). Re-export the model from FloorGen to refresh it.'
  }
}
