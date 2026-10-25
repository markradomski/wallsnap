/** Turning WallSnap's wall-local artwork (u from endpoint A, v above the floor) into FloorGen plan coordinates, once. */
import { facingRotation, flushPerp, planPoint, type WallFrame } from '../geometry'
import type { Artwork, PlanContext } from '../types'
import type { PlanItem } from './transform'

/** Thickness-aware depth of a freshly placed catalogue picture (picture-large), used until FloorGen reports a real one. */
export const DEFAULT_DEPTH_CM = 3

/** The wall's frame from the server's plan context: endpoint A, direction to B, room-facing normal. */
export function frameOf(wall: PlanContext['wall']): WallFrame {
  const length = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y)
  return { a: wall.a, b: wall.b, dir: { x: (wall.b.x - wall.a.x) / length, y: (wall.b.y - wall.a.y) / length }, normal: wall.normal, length }
}

/**
 * The item FloorGen would hold for this artwork: centred `u` from endpoint A, flush on the room face of the wall, facing the
 * room, at elevation `v`. This is the same conversion Apply relies on, so the 3D preview of an unsaved edit is exactly
 * where Apply would put it.
 */
export function localPlanItem(plan: PlanContext, art: Artwork): PlanItem {
  const depth = plan.item?.depth ?? DEFAULT_DEPTH_CM
  const p = planPoint(frameOf(plan.wall), art.u, flushPerp(plan.wall.thickness, depth))
  return { x: p.x, y: p.y, rotation: facingRotation(plan.wall.normal), width: art.width, height: art.height, depth, elevation: art.v }
}

/** The artwork as FloorGen holds it now, in plan coordinates. */
export function savedPlanItem(plan: PlanContext): PlanItem | null {
  const i = plan.item
  return i ? { x: i.x, y: i.y, rotation: i.rotation, width: i.width, height: i.height, depth: i.depth, elevation: i.elevation } : null
}
