import { describe, expect, it } from 'vitest'
import { BoundaryError, id, parseItem, parseOpening, parseWall, rev } from './boundary'
import { GatewayError, describeFailure, toResult } from './gateway'

const wall = { id: 'w_1', a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, thickness_cm: 10, entity: { height: 250 } }

describe('MCP boundary validation', () => {
  it('accepts well-formed rows', () => {
    expect(parseWall(wall).height).toBe(250)
  })
  it.each([
    ['NaN endpoint', { ...wall, a: { x: NaN, y: 0 } }],
    ['string endpoint', { ...wall, b: { x: '1', y: 0 } }],
    ['zero thickness', { ...wall, thickness_cm: 0 }],
    ['missing height', { ...wall, entity: {} }],
    ['bad id', { ...wall, id: 'w 1; drop' }],
  ])('rejects a wall with %s', (_n, row) => {
    expect(() => parseWall(row)).toThrow(BoundaryError)
  })
  it('rejects openings and items with impossible dimensions', () => {
    expect(() => parseOpening({ id: 'o', kind: 'door', wall_id: 'w', offset_cm: 10, width_cm: -1, entity: { sill: 0, height: 200 } })).toThrow(BoundaryError)
    expect(() => parseItem({ id: 'i', x: 0, y: 0, rotation: 0, entity: { width: 10, height: 10, depth: 0, elevation: 0 } })).toThrow(BoundaryError)
  })
  it('validates ids and revisions', () => {
    expect(id('w_abc|w_def-1', 'x')).toBe('w_abc|w_def-1')
    expect(() => id('../x', 'x')).toThrow(BoundaryError)
    expect(rev(1792912649771)).toBe(1792912649771)
    for (const bad of [-1, 1.5, '12', NaN, null]) expect(() => rev(bad)).toThrow(BoundaryError)
  })
  it('rejects failed or revision-less tool results', () => {
    expect(() => toResult('t', { ok: false, error: { message: 'nope' } })).toThrow(/nope/)
    expect(() => toResult('t', { ok: true, data: {} })).toThrow(/revision/)
    expect(toResult('t', { ok: true, rev: 5, data: 1 })).toEqual({ rev: 5, data: 1 })
  })
})

describe('FloorGen failure replies are surfaced, not reduced to "failed"', () => {
  const body = {
    ok: false, code: 'VALIDATION_FAILED',
    message: 'The item is 165 cm tall; at 117.6 cm up it would reach 282.6 cm but the wall is 220 cm high.',
    hint: 'Lower the elevation or pick a smaller item.', warnings: ['rounded'],
  }
  it('keeps code, message, hint and warnings', () => {
    expect(describeFailure(body)).toEqual({
      code: 'VALIDATION_FAILED',
      text: `${body.message} Hint: ${body.hint} Warning: rounded`,
    })
  })
  it('throws a GatewayError carrying the FloorGen message and code', () => {
    try {
      toResult('place_on_wall', body)
      throw new Error('should not reach')
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError)
      expect((e as GatewayError).code).toBe('VALIDATION_FAILED')
      expect((e as GatewayError).message).toContain('282.6 cm but the wall is 220 cm high')
      expect((e as GatewayError).message).not.toBe('failed')
    }
  })
  it('also understands a nested error object and a bare string', () => {
    expect(describeFailure({ ok: false, error: { code: 'X', message: 'nested' } })).toEqual({ code: 'X', text: 'nested' })
    expect(describeFailure({ ok: false, error: 'plain' }).text).toBe('plain')
  })
})
