import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayError, type Gateway } from './gateway'
import { createApp } from './index'
import { MockGateway } from './mock'

let close: (() => void) | undefined
afterEach(() => close?.())

async function serve(gw: Gateway) {
  const server = createApp(gw, 'mock-project').listen(0)
  close = () => server.close()
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('HTTP API error reporting', () => {
  it('shows the FloorGen validation message to the UI (HTTP 422), not "place_on_wall: failed"', async () => {
    const mock = new MockGateway()
    const failing: Gateway = {
      kind: 'mock',
      call: (tool, args) =>
        tool === 'place_on_wall'
          ? Promise.reject(new GatewayError('The item is 165 cm tall; at 117.6 cm up it would reach 282.6 cm but the wall is 220 cm high. Hint: Lower the elevation.', tool, 'VALIDATION_FAILED'))
          : mock.call(tool, args),
    }
    const base = await serve(failing)
    const wall = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_north`)).json()
    const res = await fetch(`${base}/api/artwork`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorId: 'f_first', wallId: 'fl_north', rev: wall.rev, artwork: { width: 60, height: 45, u: 300, v: 120 } }),
    })
    const body = await res.json()
    expect(res.status).toBe(422)
    expect(body.code).toBe('VALIDATION_FAILED')
    expect(body.error).toContain('282.6 cm but the wall is 220 cm high')
    expect(body.error).toContain('Hint: Lower the elevation')
    expect(body.error).not.toMatch(/: failed$/)
  })
})
