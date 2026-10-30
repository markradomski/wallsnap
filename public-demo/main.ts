/**
 * Public demo entry: the unchanged WallSnap app with its /api answered inside the browser, so it runs as a static site.
 * The server's own adapter runs here on the in-memory mock gateway, whose fixture the demo build swaps for the static
 * townhouse snapshot (townhouse.ts). Nothing is sent to any server: no FloorGen, no backend.
 *
 * Placements persist as a log of the visitor's saves and deletes in IndexedDB, replayed on load (the mock assigns ids
 * deterministically, so replaying gives the same artworks and ids, and images stay attached). Images use the app's own
 * IndexedDB store; the bundled GLB is put in the app's model store on first visit.
 */
import { MissingError, PartialWriteError, StaleError, ValidationError, WallSnapAdapter } from '../server/adapter'
import { GatewayError } from '../server/gateway'
import { MockGateway } from '../server/mock'
import { makeIdbKV } from '../src/imageStore'
import { checkModelBytes } from '../src/viewer3d/modelCheck'
import { idbModelStore } from '../src/viewer3d/modelStore'
import type { Artwork } from '../src/types'
import glbUrl from './townhouse.glb?url'

const PROJECT = 'wallsnap-demo'

type Op =
  | { op: 'put'; floorId: string; wallId: string; art: Artwork; rev: number; itemId: string | null; newArtwork: boolean }
  | { op: 'delete'; floorId: string; wallId: string; itemId: string; rev: number }

const kv = makeIdbKV('wallsnap-demo', 'state')
const gw = new MockGateway()
const adapter = new WallSnapAdapter(gw, PROJECT)
let log: Op[] = []

const run = (o: Op) =>
  o.op === 'put' ? adapter.apply(o.floorId, o.wallId, o.art, o.rev, o.itemId, o.newArtwork) : adapter.deleteArtwork(o.floorId, o.wallId, o.itemId, o.rev)

async function restore() {
  let saved: unknown
  try {
    saved = await kv.get('ops')
  } catch {
    return // storage unavailable: the demo still works for this visit
  }
  if (!Array.isArray(saved)) return
  try {
    for (const o of saved as Op[]) await run(o)
    log = saved as Op[]
  } catch {
    // An old or damaged log: start again with empty walls rather than half a state.
    log = []
    await kv.del('ops').catch(() => {})
    location.reload()
  }
}

async function seedModel() {
  const have = await idbModelStore.get(PROJECT)
  if (have.ok && have.value) return
  const bytes = new Uint8Array(await (await fetch(glbUrl)).arrayBuffer())
  const check = checkModelBytes(bytes)
  if (!check.ok) return
  const summary = { floors: check.info.floors.length, triangles: check.info.triangles, generator: check.info.generator }
  await idbModelStore.put(PROJECT, { blob: new Blob([bytes], { type: 'model/gltf-binary' }), name: 'townhouse-demo.glb', size: bytes.byteLength, summary })
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The same routes and error mapping as server/index.ts. */
async function api(url: URL, init?: RequestInit): Promise<Response> {
  const q = url.searchParams
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  try {
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/status': return json(200, { adapter: 'mock', project: PROJECT, viewer3dUrl: null })
      // Only floors with walls to hang on: the ground floor is in the data just to keep storey heights right.
      case 'GET /api/floors': return json(200, (await adapter.listFloors()).filter((f) => f.walls.length))
      case 'GET /api/wall': return json(200, await adapter.loadWall(q.get('floor')!, q.get('wall')!, q.get('item') ?? undefined))
      case 'GET /api/plan': return json(200, await adapter.planContext(q.get('floor')!, q.get('wall')!, q.get('item') ?? undefined))
      case 'GET /api/artworks': return json(200, await adapter.artworks())
      case 'GET /api/walk': return json(200, await adapter.walkData(q.get('floor')!))
      case 'PUT /api/artwork': {
        const o: Op = { op: 'put', floorId: String(body.floorId), wallId: String(body.wallId), art: body.artwork as Artwork, rev: Number(body.rev), itemId: typeof body.itemId === 'string' ? body.itemId : null, newArtwork: body.newArtwork === true }
        const r = await run(o)
        log.push(o)
        await kv.put('ops', log).catch(() => {})
        return json(200, r)
      }
      case 'DELETE /api/artwork': {
        const o: Op = { op: 'delete', floorId: String(body.floorId), wallId: String(body.wallId), itemId: String(body.itemId), rev: Number(body.rev) }
        const r = await run(o)
        log.push(o)
        await kv.put('ops', log).catch(() => {})
        return json(200, r)
      }
      default: return json(404, { error: 'Not found' })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unexpected error'
    if (e instanceof StaleError) return json(409, { error: message, code: 'stale' })
    if (e instanceof ValidationError) return json(422, { error: message, problems: e.problems })
    if (e instanceof MissingError) return json(404, { error: message, code: e.code })
    if (e instanceof PartialWriteError) return json(502, { error: message, code: 'partial' })
    if (e instanceof GatewayError && e.code === 'VALIDATION_FAILED') return json(422, { error: `Rejected the placement: ${message}`, code: e.code })
    return json(500, { error: message })
  }
}

const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin)
  return url.origin === location.origin && url.pathname.startsWith('/api/') ? api(url, init) : realFetch(input, init)
}

/**
 * The app's mock banner, relabelled for the public demo. The 3D view's note that an artwork is missing from the export
 * (asking for a FloorGen re-export) is hidden: the demo model deliberately has no artworks of its own.
 */
new MutationObserver(() => {
  for (const el of document.querySelectorAll<HTMLElement>('p, div')) {
    const t = el.textContent ?? ''
    if (el.tagName === 'P' && t.startsWith('MOCK ADAPTER')) el.textContent = 'DEMO MODE: a static copy of the townhouse, not connected to FloorGen. Your images and placements stay in this browser.'
    else if (t.startsWith('This artwork is not in the 3D model') && el.childElementCount === 0) el.style.display = 'none'
  }
}).observe(document.documentElement, { childList: true, subtree: true })

await Promise.all([restore(), seedModel().catch(() => {})])
await import('../src/main')
