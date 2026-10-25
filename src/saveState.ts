import type { Artwork } from './types'

export type SaveState =
  | 'none' | 'loading' | 'saving' | 'conflict' | 'partial' | 'error' | 'invalid' | 'new' | 'unsaved' | 'synced' | 'verified'

export const SAVE_LABEL: Record<SaveState, string> = {
  none: 'No wall selected',
  loading: 'Loading…',
  saving: 'Saving…',
  conflict: 'Revision conflict',
  partial: 'Partially saved',
  error: 'Save failed',
  invalid: 'Fix validation errors',
  new: 'Not saved yet',
  unsaved: 'Unsaved changes',
  synced: 'Loaded from FloorGen',
  verified: 'Saved · verified',
}

/** A shape/glyph per state so nothing relies on colour alone. */
export const SAVE_GLYPH: Record<SaveState, string> = {
  none: '–', loading: '…', saving: '↻', conflict: '⚠', partial: '◐', error: '✕', invalid: '✕', new: '●', unsaved: '●', synced: '✓', verified: '✓',
}

export const sameArtwork = (a: Artwork, b: Artwork, tol = 0.05) =>
  (['width', 'height', 'u', 'v'] as const).every((k) => Math.abs(a[k] - b[k]) <= tol)

export interface SaveInputs {
  hasWall: boolean
  loading: boolean
  saving: boolean
  conflict: boolean
  partial: boolean
  error: boolean
  problems: number
  /** What FloorGen last confirmed holding for this wall (null: no artwork saved yet). */
  baseline: Artwork | null
  current: Artwork | null
  /** True only after an Apply whose read-back verification passed, until the next edit. */
  verified: boolean
}

/** Success ("verified") is only ever shown after read-back verification and while nothing has been edited since. */
export function deriveSaveState(i: SaveInputs): SaveState {
  if (i.loading) return 'loading'
  if (!i.hasWall || !i.current) return 'none'
  if (i.saving) return 'saving'
  if (i.conflict) return 'conflict'
  if (i.partial) return 'partial'
  if (i.error) return 'error'
  if (i.problems > 0) return 'invalid'
  if (!i.baseline) return 'new'
  if (!sameArtwork(i.baseline, i.current)) return 'unsaved'
  return i.verified ? 'verified' : 'synced'
}
