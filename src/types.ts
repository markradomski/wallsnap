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
