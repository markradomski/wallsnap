/**
 * Read-only companion for the 3D feasibility spike. It never writes to FloorGen: it only issues list_floors and
 * list_entities through the same DEV-only guarded gateway as the main app, so the API key stays server-side.
 *
 *   GET /model.glb  the exported townhouse model, from SPIKE_GLB_PATH (default ~/Downloads/townhouse-wallsnap-dev-3d.glb).
 *                   It is a private project export, so it is served from where it already is and never committed.
 *   GET /model-info what the GLB declares per floor (meshes, triangles, bounds), read from its JSON chunk.
 *   GET /artwork    the live WallSnap artwork on the first-floor living-room north wall, in FloorGen plan coordinates.
 */
import express from 'express'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WallSnapAdapter } from '../server/adapter'
import { arr, id, isRec, num, parseItem, parseRoom, parseWall, rec, str } from '../server/boundary'
import { createGateway } from '../server/index'
import { wallCoords, wallFrame } from '../src/geometry'
import { describeFloors, readGlbJson } from './glbInfo'

const GLB = process.env.SPIKE_GLB_PATH ?? join(homedir(), 'Downloads', 'townhouse-wallsnap-dev-3d.glb')
const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

const { gw, project } = createGateway()
const adapter = new WallSnapAdapter(gw, project)
const app = express()

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  next()
})

app.get('/model.glb', (_req, res) => {
  if (!existsSync(GLB)) return res.status(404).json({ error: `GLB not found at ${GLB}. Set SPIKE_GLB_PATH.` })
  res.setHeader('Content-Type', 'model/gltf-binary')
  res.setHeader('Content-Length', statSync(GLB).size)
  createReadStream(GLB).pipe(res)
})

/** What the GLB file itself declares per floor (read from its JSON chunk), for the viewer to compare against its scene. */
app.get('/model-info', (_req, res) => {
  try {
    if (!existsSync(GLB)) return res.status(404).json({ error: `GLB not found at ${GLB}. Set SPIKE_GLB_PATH.` })
    res.json({ file: GLB, bytes: statSync(GLB).size, floors: describeFloors(readGlbJson(readFileSync(GLB))) })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unreadable GLB' })
  }
})

app.get('/artwork', async (_req, res) => {
  try {
    // Floors, lowest first, with their heights: the first floor's base is the summed heights below it.
    const fl = await gw.call('list_floors', { project })
    const floors = arr(rec(fl.data, 'data').floors, 'floors').map((f) => {
      const r = rec(f, 'floor')
      return { id: id(r.id, 'floor.id'), name: str(r.name, 'floor.name'), height: num(r.height, 'floor.height') }
    })
    const floor = floors[1]
    if (!floor) throw new Error('The project has no first floor.')
    const baseCm = floors.slice(0, 1).reduce((s, f) => s + f.height, 0)

    // The living-room north wall, found the way the app lists walls (no hard-coded ids).
    const summary = (await adapter.listFloors()).find((f) => f.id === floor.id)
    const wallInfo = summary?.walls
      .filter((w) => w.label.startsWith('Living') && w.label.includes('north wall'))
      .sort((a, b) => b.length - a.length)[0]
    if (!wallInfo) throw new Error('No living-room north wall found on the first floor.')

    // The WallSnap artwork on it, through the same read the app uses (so the item id and u/v are the app's own).
    const state = await adapter.loadWall(floor.id, wallInfo.id)
    if (!state.artworkId || !state.artwork) throw new Error('There is no WallSnap artwork on that wall.')

    // Raw plan-space data for the geometry.
    const ent = await gw.call('list_entities', { project, floor: floor.id, type: ['wall', 'room', 'item'], detail: 'full', limit: 1000 })
    const rows = arr(rec(ent.data, 'data').rows, 'rows').filter(isRec)
    const wall = parseWall(rows.find((r) => r.type === 'wall' && r.id === wallInfo.id))
    const room = parseRoom(rows.find((r) => r.type === 'room' && Array.isArray(r.wall_ids) && r.wall_ids.includes(wall.id)))
    const rawItem = rows.find((r) => r.type === 'item' && r.id === state.artworkId)
    const item = parseItem(rawItem)
    const frame = wallFrame(wall.a, wall.b, room.centroid)
    const wc = wallCoords(frame, item)

    res.json({
      project,
      rev: ent.rev,
      floor: { id: floor.id, name: floor.name, baseCm, heightCm: floor.height },
      wall: { id: wall.id, label: wallInfo.label, length: frame.length, height: wall.height, thickness: wall.thickness, a: wall.a, b: wall.b, normal: frame.normal },
      item: { ...item, mirror: isRec(rawItem) && isRec(rawItem.entity) ? rawItem.entity.mirror === true : false },
      wallCoords: { u: wc.u, perp: wc.perp },
      appArtwork: state.artwork, // the app's own u/v/width/height for the same item, to cross-check
    })
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Unexpected error' })
  }
})

const port = Number(process.env.WALLSNAP_SPIKE_PORT ?? 8788)
app.listen(port, () => console.log(`WallSnap 3D spike server on :${port} (read-only) — GLB: ${GLB}`))
