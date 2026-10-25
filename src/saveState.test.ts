import { describe, expect, it } from 'vitest'
import { deriveSaveState, sameArtwork, type SaveInputs } from './saveState'
import { THEME_KEY, isPref, resolveTheme } from './theme'

const art = { width: 60, height: 45, u: 300, v: 120 }
const base: SaveInputs = {
  hasWall: true, loading: false, saving: false, conflict: false, partial: false, error: false,
  problems: 0, baseline: art, current: art, verified: false,
}
const s = (o: Partial<SaveInputs>) => deriveSaveState({ ...base, ...o })

describe('save state', () => {
  it('shows verified only after verification, and only while nothing was edited since', () => {
    expect(s({})).toBe('synced')
    expect(s({ verified: true })).toBe('verified')
    expect(s({ verified: true, current: { ...art, u: 301 } })).toBe('unsaved')
  })
  it('treats sub-tolerance noise as unchanged but a real edit as unsaved', () => {
    expect(sameArtwork(art, { ...art, u: 300.04 })).toBe(true)
    expect(sameArtwork(art, { ...art, u: 300.2 })).toBe(false)
  })
  it('distinguishes every state', () => {
    expect(s({ baseline: null })).toBe('new')
    expect(s({ current: { ...art, v: 130 } })).toBe('unsaved')
    expect(s({ problems: 2 })).toBe('invalid')
    expect(s({ saving: true })).toBe('saving')
    expect(s({ conflict: true })).toBe('conflict')
    expect(s({ partial: true })).toBe('partial')
    expect(s({ error: true })).toBe('error')
    expect(s({ loading: true })).toBe('loading')
    expect(s({ hasWall: false })).toBe('none')
  })
  it('puts in-flight and server-reported states ahead of edit state', () => {
    const edited = { current: { ...art, u: 1 }, problems: 1 }
    expect(s({ ...edited, saving: true })).toBe('saving')
    expect(s({ ...edited, conflict: true })).toBe('conflict')
    expect(s({ ...edited, partial: true })).toBe('partial')
    expect(s({ ...edited, error: true })).toBe('error')
  })
  it('never claims verified while invalid or saving', () => {
    expect(s({ verified: true, problems: 1 })).toBe('invalid')
    expect(s({ verified: true, saving: true })).toBe('saving')
  })
})

describe('theme preference', () => {
  it('system follows the OS; explicit choices ignore it', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('accepts only the three known preferences', () => {
    expect(['system', 'light', 'dark'].every(isPref)).toBe(true)
    expect([null, 'auto', 'DARK', 3].some(isPref)).toBe(false)
    expect(THEME_KEY).toBe('wallsnap.theme')
  })
})
