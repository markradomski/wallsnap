import express from 'express'
import type { Artwork } from '../src/types'
import { MissingError, PartialWriteError, StaleError, ValidationError, WallSnapAdapter } from './adapter'
import { BoundaryError, isRec, num, rev } from './boundary'
import { FloorGenGateway, GatewayError, type Gateway } from './gateway'
import { MockGateway } from './mock'
import { ORIGINAL_PROJECT, SafetyError, WRITABLE_PROJECT, guardWrites, viewer3dUrl } from './safety'

/** Startup safeguard (in addition to the per-write guard): only the development copy may be configured. */
export function createGateway(env: Record<string, string | undefined> = process.env): { gw: Gateway; project: string } {
  if (env.WALLSNAP_ADAPTER === 'mock') return { gw: guardWrites(new MockGateway(), 'mock-project'), project: 'mock-project' }
  const project = env.FLOORGEN_PROJECT_ID
  const key = env.FLOORGEN_API_KEY
  if (project === ORIGINAL_PROJECT) throw new SafetyError('Refusing to run against the original townhouse. Use the development copy.')
  if (project !== WRITABLE_PROJECT) throw new SafetyError(`FLOORGEN_PROJECT_ID must be the development copy ${WRITABLE_PROJECT}. See .env.example.`)
  if (!key) throw new Error('FLOORGEN_API_KEY is not set. See README, or run with WALLSNAP_ADAPTER=mock.')
  const url = env.FLOORGEN_MCP_URL ?? 'https://floorgen.app/mcp?toolsets=core,more,stairs'
  return { gw: guardWrites(new FloorGenGateway(url, key), WRITABLE_PROJECT), project }
}

function parseArtwork(v: unknown): Artwork {
  if (!isRec(v)) throw new ValidationError(['Malformed request.'])
  const n = (k: string) => (typeof v[k] === 'number' ? num(v[k], k) : NaN)
  return { width: n('width'), height: n('height'), u: n('u'), v: n('v') }
}

export function createApp(gw: Gateway, project: string) {
  const adapter = new WallSnapAdapter(gw, project)
  const app = express()
  app.use(express.json())

  const wrap = (fn: (req: express.Request) => Promise<unknown>): express.RequestHandler => (req, res) =>
    fn(req).then(
      (body) => res.json(body),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : 'Unexpected error'
        if (e instanceof StaleError) return res.status(409).json({ error: message, code: 'stale' })
        if (e instanceof ValidationError) return res.status(422).json({ error: message, problems: e.problems })
        if (e instanceof MissingError) return res.status(404).json({ error: message, code: e.code })
        if (e instanceof PartialWriteError) return res.status(502).json({ error: message, code: 'partial' })
        if (e instanceof SafetyError) return res.status(403).json({ error: message })
        // Server-side log only; error text comes from FloorGen and never contains credentials.
        console.error(e instanceof GatewayError ? `[FloorGen ${e.tool}${e.code ? ' ' + e.code : ''}] ${message}` : e)
        if (e instanceof GatewayError && e.code === 'VALIDATION_FAILED') return res.status(422).json({ error: `FloorGen rejected the placement: ${message}`, code: e.code })
        res.status(e instanceof GatewayError || e instanceof BoundaryError ? 502 : 500).json({ error: e instanceof GatewayError ? `FloorGen ${e.tool} failed: ${message}` : message })
      },
    )

  app.get('/api/status', (_q, res) => res.json({ adapter: gw.kind, project, viewer3dUrl: gw.kind === 'floorgen' ? viewer3dUrl(project) : null }))
  app.get('/api/floors', wrap(() => adapter.listFloors()))
  app.get('/api/wall', wrap((q) => adapter.loadWall(String(q.query.floor), String(q.query.wall), typeof q.query.item === 'string' ? q.query.item : undefined)))
  // Read-only plan geometry for the 3D preview (never writes).
  app.get('/api/plan', wrap((q) => adapter.planContext(String(q.query.floor), String(q.query.wall), typeof q.query.item === 'string' ? q.query.item : undefined)))
  app.put('/api/artwork', wrap(async (q) => {
    const body: unknown = q.body
    if (!isRec(body) || typeof body.floorId !== 'string' || typeof body.wallId !== 'string') {
      throw new ValidationError(['Malformed request.'])
    }
    let r: number
    try {
      r = rev(body.rev)
    } catch {
      throw new ValidationError(['Malformed revision.'])
    }
    const art = parseArtwork(body.artwork)
    const itemId = typeof body.itemId === 'string' ? body.itemId : null
    return adapter.apply(body.floorId, body.wallId, art, r, itemId)
  }))
  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { gw, project } = createGateway()
  const port = Number(process.env.WALLSNAP_API_PORT ?? 8787)
  createApp(gw, project).listen(port, () => {
    console.log(`WallSnap API on :${port} — adapter: ${gw.kind}${gw.kind === 'mock' ? ' (MOCK DATA, not FloorGen)' : ` project ${project}`}`)
  })
}
