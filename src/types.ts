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

export interface WallState {
  wall: WallView
  artwork: Artwork | null
  rev: number
}

export interface ApplyResult {
  artwork: Artwork
  rev: number
  created: boolean
}
