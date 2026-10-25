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

describe('Reload over HTTP', () => {
  const put = (base: string, rev: number, art: object, itemId?: string) =>
    fetch(`${base}/api/artwork`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorId: 'f_first', wallId: 'fl_east', rev, artwork: art, itemId }),
    })

  it('returns the saved artwork id, then reflects an external edit, with no writes', async () => {
    const mock = new MockGateway()
    const writes: string[] = []
    const gw: Gateway = { kind: 'mock', call: (t, a) => (['place_on_wall', 'update_items'].includes(t) && writes.push(t), mock.call(t, a)) }
    const base = await serve(gw)
    const wall0 = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
    const saved = await (await put(base, wall0.rev, { width: 60, height: 40, u: 100, v: 100 })).json()
    expect(saved.artworkId).toMatch(/^i_/)

    mock.resizeItem(saved.artworkId, { width: 75 })
    writes.length = 0
    const res = await fetch(`${base}/api/wall?floor=f_first&wall=fl_east&item=${saved.artworkId}`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.artwork).toMatchObject({ width: 75, height: 40 })
    expect(body.artworkId).toBe(saved.artworkId)
    expect(body.rev).toBeGreaterThan(saved.rev)
    expect(writes).toEqual([])
  })

  it('answers 404 with a specific code for a deleted artwork and for a missing wall', async () => {
    const mock = new MockGateway()
    const base = await serve(mock)
    const wall0 = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
    const saved = await (await put(base, wall0.rev, { width: 60, height: 40, u: 100, v: 100 })).json()

    mock.hideWall('fl_east')
    const noWall = await fetch(`${base}/api/wall?floor=f_first&wall=fl_east&item=${saved.artworkId}`)
    expect([noWall.status, (await noWall.json()).code]).toEqual([404, 'wall_missing'])

    const mock2 = new MockGateway()
    const base2 = await serve(mock2)
    const w = await (await fetch(`${base2}/api/wall?floor=f_first&wall=fl_east`)).json()
    const s2 = await (await put(base2, w.rev, { width: 60, height: 40, u: 100, v: 100 })).json()
    mock2.deleteItem(s2.artworkId)
    const gone = await fetch(`${base2}/api/wall?floor=f_first&wall=fl_east&item=${s2.artworkId}`)
    const goneBody = await gone.json()
    expect([gone.status, goneBody.code]).toEqual([404, 'artwork_missing'])
    expect(goneBody.error).toMatch(/no longer exists/)
  })

  it('reports an artwork dragged off the wall without coordinates', async () => {
    const mock = new MockGateway()
    const base = await serve(mock)
    const w = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
    const s = await (await put(base, w.rev, { width: 60, height: 40, u: 100, v: 100 })).json()
    mock.moveItem(s.artworkId, { x: 250 })
    const body = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east&item=${s.artworkId}`)).json()
    expect(body.artwork).toBeNull()
    expect(body.detached.message).toBe('Artwork is no longer positioned on this wall.')
  })

  it('Apply with a stale revision is still refused, and with the reloaded one it updates the same object', async () => {
    const mock = new MockGateway()
    const base = await serve(mock)
    const w = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
    const s = await (await put(base, w.rev, { width: 60, height: 40, u: 100, v: 100 })).json()
    mock.touch()
    const stale = await put(base, s.rev, { width: 60, height: 40, u: 120, v: 100 }, s.artworkId)
    expect([stale.status, (await stale.json()).code]).toEqual([409, 'stale'])
    const fresh = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east&item=${s.artworkId}`)).json()
    const ok = await (await put(base, fresh.rev, { width: 60, height: 40, u: 120, v: 100 }, s.artworkId)).json()
    expect([ok.artworkId, ok.created]).toEqual([s.artworkId, false])
  })
})

describe('artwork images stay out of the server and FloorGen', () => {
  it('has no image or upload route, and PUT /api/artwork rejects extra image data without writing it', async () => {
    const mock = new MockGateway()
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    const gw: Gateway = { kind: 'mock', call: (tool, args) => (calls.push({ tool, args }), mock.call(tool, args)) }
    const base = await serve(gw)
    for (const path of ['/api/image', '/api/upload', '/api/images/x']) {
      for (const method of ['GET', 'POST', 'PUT']) {
        expect((await fetch(`${base}${path}`, { method })).status, `${method} ${path}`).toBe(404)
      }
    }
    const wall = await (await fetch(`${base}/api/wall?floor=f_first&wall=fl_east`)).json()
    const res = await fetch(`${base}/api/artwork`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        floorId: 'f_first', wallId: 'fl_east', rev: wall.rev, itemId: null,
        artwork: { width: 60, height: 40, u: 100, v: 100 },
        image: 'data:image/png;base64,AAAA', texture: 'data:image/png;base64,BBBB',
      }),
    })
    expect(res.status).toBe(200)
    // Whatever the client sends, FloorGen only ever receives the documented geometry fields.
    const sent = JSON.stringify(calls.filter((c) => ['place_on_wall', 'update_items'].includes(c.tool)))
    expect(sent).not.toMatch(/data:image|base64|texture|image/i)
  })
})

describe('GET /api/plan', () => {
  it('returns plan geometry and is read-only', async () => {
    const mock = new MockGateway()
    const writes: string[] = []
    const gw: Gateway = { kind: 'mock', call: (t, a) => (['place_on_wall', 'update_items', 'place_item'].includes(t) && writes.push(t), mock.call(t, a)) }
    const base = await serve(gw)
    const res = await fetch(`${base}/api/plan?floor=f_first&wall=fl_north`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ floorId: 'f_first', baseCm: 250, item: null })
    expect(body.wall).toMatchObject({ id: 'fl_north', length: 600, thickness: 15, normal: { x: 0, y: 1 } })
    expect(writes).toEqual([])
  })
  it('404s with the same codes as /api/wall for a missing artwork or wall', async () => {
    const base = await serve(new MockGateway())
    const a = await fetch(`${base}/api/plan?floor=f_first&wall=fl_north&item=i_nope`)
    expect([a.status, (await a.json()).code]).toEqual([404, 'artwork_missing'])
    const w = await fetch(`${base}/api/plan?floor=f_first&wall=w_nope`)
    expect([w.status, (await w.json()).code]).toEqual([404, 'wall_missing'])
  })
})
