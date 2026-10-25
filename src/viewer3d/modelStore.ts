/**
 * The imported 3D model (a GLB snapshot of the townhouse), kept in this browser only. One model per FloorGen project; it
 * never leaves the machine and is never committed. Same failure-reporting style as the image store.
 */
import { makeIdbKV, type KV } from '../imageStore'

export interface StoredModel {
  blob: Blob
  name: string
  size: number
  /** Epoch ms of the import. */
  importedAt: number
  summary: { floors: number; triangles: number; generator?: string }
}

export type ModelGet = { ok: true; value: StoredModel | null } | { ok: false; reason: 'unavailable' | 'corrupt' }
export type ModelPut = { ok: true } | { ok: false; reason: 'unavailable' | 'full' }

export const modelKey = (project: string) => `${project}/townhouse-model`

function asModel(v: unknown): StoredModel | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const s = r.summary as Record<string, unknown> | undefined
  const ok =
    r.blob instanceof Blob && r.blob.size > 0 && typeof r.name === 'string' && typeof r.size === 'number' &&
    typeof r.importedAt === 'number' && !!s && typeof s.floors === 'number' && typeof s.triangles === 'number'
  return ok ? (r as unknown as StoredModel) : null
}

export function createModelStore(kv: KV) {
  return {
    async get(project: string): Promise<ModelGet> {
      let raw: unknown
      try {
        raw = await kv.get(modelKey(project))
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (raw === undefined || raw === null) return { ok: true, value: null }
      const value = asModel(raw)
      return value ? { ok: true, value } : { ok: false, reason: 'corrupt' }
    },
    /** Imports or replaces the project's model. */
    async put(project: string, model: Omit<StoredModel, 'importedAt'> & { importedAt?: number }): Promise<ModelPut> {
      try {
        await kv.put(modelKey(project), { ...model, importedAt: model.importedAt ?? Date.now() })
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: e instanceof Error && /quota/i.test(`${e.name} ${e.message}`) ? 'full' : 'unavailable' }
      }
    },
  }
}

export const idbModelStore = createModelStore(makeIdbKV('wallsnap-models', 'models'))
