/**
 * Is this file a usable FloorGen building export? Decided from the GLB's JSON declarations only (nothing is decoded or run),
 * so a wrong or damaged file is rejected with something the user can act on before it ever reaches the renderer.
 */
import { categoryOf } from './look'
import { describeFloors, readGlbJson, type Bounds, type FloorInfo } from './glbInfo'

export const MAX_MODEL_BYTES = 100 * 1024 * 1024

export interface ModelInfo {
  generator?: string
  floors: FloorInfo[]
  triangles: number
  /** Whole-building bounds, metres. */
  bounds: Bounds
}

export type ModelCheck = { ok: true; info: ModelInfo; warnings: string[] } | { ok: false; error: string }

const fail = (error: string): ModelCheck => ({ ok: false, error })
const EXPORT_HINT = 'In FloorGen, export the building as a 3D model (GLB).'

export function checkModelBytes(bytes: Uint8Array): ModelCheck {
  if (bytes.byteLength === 0) return fail('That file is empty.')
  if (bytes.byteLength > MAX_MODEL_BYTES) return fail(`That file is ${(bytes.byteLength / 1048576).toFixed(0)} MB; the limit is ${MAX_MODEL_BYTES / 1048576} MB.`)

  let gltf
  try {
    gltf = readGlbJson(bytes)
  } catch (e) {
    return fail(`This is not a readable GLB file (${e instanceof Error ? e.message : 'unreadable'}). ${EXPORT_HINT}`)
  }
  if (!Array.isArray(gltf.scenes) || !Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes) || !Array.isArray(gltf.accessors)) {
    return fail(`This GLB has no scene geometry. ${EXPORT_HINT}`)
  }

  let floors: FloorInfo[]
  try {
    floors = describeFloors(gltf)
  } catch {
    return fail(`This GLB's structure could not be read. ${EXPORT_HINT}`)
  }
  floors = floors.filter((f) => f.meshes > 0 && f.bounds)
  const triangles = floors.reduce((n, f) => n + f.triangles, 0)
  if (floors.length === 0 || triangles < 12) return fail(`The file contains no usable building geometry. ${EXPORT_HINT}`)

  // FloorGen exports one group per storey with walls / floors / furniture / stairs meshes inside. Anything else is not it.
  const hasWalls = (f: FloorInfo) => f.categories.some((c) => categoryOf(c.name) === 'walls' && c.triangles > 0)
  if (!floors.some(hasWalls)) {
    return fail(`This does not look like a FloorGen building export (no storeys with walls). ${EXPORT_HINT}`)
  }

  const min: Bounds['min'] = [Infinity, Infinity, Infinity]
  const max: Bounds['max'] = [-Infinity, -Infinity, -Infinity]
  for (const f of floors) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], f.bounds!.min[k])
    max[k] = Math.max(max[k], f.bounds!.max[k])
  }
  if (![...min, ...max].every(Number.isFinite)) return fail('The model contains invalid coordinates.')

  // Units and orientation: FloorGen's GLB is metres, Y up. A building is metres across and a few to tens of metres tall.
  const [dx, dy, dz] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  if (dx < 1 || dz < 1 || dx > 200 || dz > 200 || dy < 1.5 || dy > 100) {
    return fail(
      `The model is ${dx.toFixed(1)} × ${dz.toFixed(1)} m wide and ${dy.toFixed(1)} m tall, which is not a plausible building in metres with Y up. ` +
        `WallSnap only reads FloorGen's own export. ${EXPORT_HINT}`,
    )
  }

  const warnings: string[] = []
  const generator = gltf.asset?.generator
  if (!/floorgen/i.test(generator ?? '')) warnings.push('This file was not written by FloorGen, so its coordinates may not match the plan.')
  if (Math.abs(min[1]) > 0.1) warnings.push('The model does not start at ground level (Y = 0), so heights may be offset.')
  return { ok: true, info: { generator, floors, triangles, bounds: { min, max } }, warnings }
}

/**
 * Does the selected wall lie inside the model? If not, the model is a different project or an old, very different export,
 * and the artwork preview would float in space. Plan centimetres against model metres (X = x/100, Z = y/100).
 */
export function wallFitsModel(bounds: Bounds, a: { x: number; y: number }, b: { x: number; y: number }, marginM = 0.3): string | null {
  const inside = (p: { x: number; y: number }) =>
    p.x / 100 >= bounds.min[0] - marginM && p.x / 100 <= bounds.max[0] + marginM && p.y / 100 >= bounds.min[2] - marginM && p.y / 100 <= bounds.max[2] + marginM
  return inside(a) && inside(b)
    ? null
    : 'The selected wall is outside this 3D model, so it is probably a different project or an out-of-date export. Re-export the model from FloorGen.'
}
