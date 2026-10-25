import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayError, type Gateway } from './gateway'
import { createApp } from './index'
import { MockGateway } from './mock'
import { ORIGINAL_PROJECT, WRITABLE_PROJECT } from './safety'

let close: (() => void) | undefined
afterEach(() => close?.())

async function serve(gw: Gateway, project = 'mock-project') {
  const server = createApp(gw, project).listen(0)
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

describe('partial save', () => {
  it('reports code "partial" with the saved-state description', async () => {
    const mock = new MockGateway()
    let moves = 0
    const gw: Gateway = {
      kind: 'mock',
      call: (tool, args) => (tool === 'place_on_wall' && args.item_id && ++moves ? Promise.reject(new GatewayError('nope', tool)) : mock.call(tool, args)),
    }
    const base = await serve(gw)
    const put = async (art: object) => {
      const wall = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
      return fetch(`${base}/api/artwork`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ floorId: 'f_first', wallId: 'fl_east', rev: wall.rev, artwork: art }) })
    }
    expect((await put({ width: 60, height: 40, u: 100, v: 100 })).status).toBe(200) // create: only catalogue placement
    const res = await put({ width: 90, height: 50, u: 200, v: 100 })
    const body = await res.json()
    expect([res.status, body.code]).toEqual([502, 'partial'])
    expect(body.error).toMatch(/Partially saved: it was resized to 90×50 cm/)
  })
})

describe('/api/status 3D link', () => {
  const live: Gateway = { kind: 'floorgen', call: () => Promise.reject(new Error('not used')) }
  const status = async (gw: Gateway, project: string) => (await fetch(`${await serve(gw, project)}/api/status`)).json()

  it('gives the dev project 3D URL for the live adapter', async () => {
    expect((await status(live, WRITABLE_PROJECT)).viewer3dUrl).toBe('https://floorgen.app/projects#/p/p_1ii0qmfr58hv4/3d')
  })
  it('never gives a link for the original project or the mock', async () => {
    expect((await status(live, ORIGINAL_PROJECT)).viewer3dUrl).toBeNull()
    expect((await status(new MockGateway(), 'mock-project')).viewer3dUrl).toBeNull()
  })
})
