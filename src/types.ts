/** All lengths in centimetres. */
export interface Opening {
  id: string
  kind: string
  /** Start of the opening along the wall, measured from endpoint A. */
  left: number
  width: number
  sill: number
  height: number
}

export interface WallSummary {
  id: string
  length: number
  height: number
  reserved: boolean
  label: string
}

export interface FloorSummary {
  id: string
  name: string
  walls: WallSummary[]
}

export interface WallView {
  id: string
  floorId: string
  length: number
  height: number
  openings: Opening[]
}

/** Wall-local placement: u is measured from endpoint A to the artwork centre, v is the bottom edge above the floor. */
export interface Artwork {
  width: number
  height: number
  u: number
  v: number
}

/** The saved artwork exists but is not hanging on this wall; its position is deliberately not converted. */
export interface Detached {
  message: string
  reasons: string[]
  /** Its own size and elevation, so it can be placed back on the wall. */
  width: number
  height: number
  elevation: number
}

export interface WallState {
  wall: WallView
  artwork: Artwork | null
  /** FloorGen's persistent id of the WallSnap artwork, once known. Reload and Apply act on this object. */
  artworkId: string | null
  detached: Detached | null
  rev: number
}

export interface ApplyResult {
  artwork: Artwork
  artworkId: string
  rev: number
  created: boolean
}

/** Plan-space data for the 3D preview (read-only; FloorGen plan units, centimetres). */
export interface PlanContext {
  rev: number
  /** All storeys, lowest first, with heights. */
  floors: { id: string; name: string; height: number }[]
  floorId: string
  /** Height of the selected floor's base: the summed heights of the floors below it. */
  baseCm: number
  wall: {
    id: string
    a: { x: number; y: number }
    b: { x: number; y: number }
    length: number
    height: number
    thickness: number
    /** Unit plan vector from the wall towards the room the artwork hangs in. */
    normal: { x: number; y: number }
  }
  /** The saved FloorGen artwork on this wall (raw plan coordinates), or null. */
  item: { id: string; x: number; y: number; rotation: number; width: number; height: number; depth: number; elevation: number; color: string } | null
}

/**
 * Everything Walk mode needs to know about one storey, in FloorGen plan units (centimetres). Read-only, from one revision.
 * Collision shapes are derived from it on the client by pure functions (src/viewer3d/walkGeometry.ts).
 */
export interface WalkData {
  rev: number
  floorId: string
  /** Height of the floor's base above the ground: the summed heights of the floors below. */
  baseCm: number
  walls: { id: string; a: { x: number; y: number }; b: { x: number; y: number }; thickness: number }[]
  openings: { id: string; wallId: string; kind: string; offset: number; width: number; sill: number; height: number; exterior: boolean }[]
  /** Furniture and objects on this floor (the WallSnap artwork carries its tag). */
  items: { id: string; x: number; y: number; rotation: number; width: number; depth: number; height: number; elevation: number; tag?: string }[]
  /** Stairs that start on this floor. */
  stairs: StairInfo[]
  /** Stairs that start on the floor below: where they cut an opening in this floor's slab. */
  stairsBelow: StairInfo[]
}
export interface StairInfo { id: string; x: number; y: number; rotation: number; width: number; steps: number; treadDepth: number; nosing: number; cutOpening: boolean; wellGap: number }
