/**
 * Local-only storage for artwork images (IndexedDB). Images never go to FloorGen or any server: FloorGen's item tools
 * expose no custom image field. Large blobs stay out of localStorage. Every operation reports failure instead of
 * throwing, because storage can be missing, blocked, full or damaged.
 */

export interface StoredImage {
  blob: Blob
  name: string
  type: string
  /** Pixel size of the original image. */
  width: number
  height: number
  savedAt: number
}

/** The minimal storage surface the logic needs; IndexedDB implements it, tests use a Map. */
export interface KV {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  del(key: string): Promise<void>
}

export type GetResult =
  | { ok: true; value: StoredImage | null }
  | { ok: false; reason: 'unavailable' | 'corrupt' }
export type OpResult = { ok: true } | { ok: false; reason: 'unavailable' | 'full' }

/** Keys tie an image to the FloorGen project and the persistent artwork item id, or to a not-yet-saved wall draft. */
export const itemKey = (project: string, itemId: string) => `${project}/item/${itemId}`
export const draftKey = (project: string, floorId: string, wallId: string) => `${project}/draft/${floorId}/${wallId}`

function asStored(v: unknown): StoredImage | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const ok =
    r.blob instanceof Blob && r.blob.size > 0 && typeof r.name === 'string' && typeof r.type === 'string' &&
    typeof r.width === 'number' && typeof r.height === 'number' && r.width >= 1 && r.height >= 1 && typeof r.savedAt === 'number'
  return ok ? (r as unknown as StoredImage) : null
}

const isQuota = (e: unknown) => e instanceof Error && /quota/i.test(`${e.name} ${e.message}`)

export function createImageStore(kv: KV) {
  return {
    async get(key: string): Promise<GetResult> {
      let raw: unknown
      try {
        raw = await kv.get(key)
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
      if (raw === undefined || raw === null) return { ok: true, value: null }
      const value = asStored(raw)
      return value ? { ok: true, value } : { ok: false, reason: 'corrupt' }
    },

    /** Stores or replaces the image under `key`. */
    async put(key: string, image: Omit<StoredImage, 'savedAt'>): Promise<OpResult> {
      try {
        await kv.put(key, { ...image, savedAt: Date.now() })
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: isQuota(e) ? 'full' : 'unavailable' }
      }
    },

    async remove(key: string): Promise<OpResult> {
      try {
        await kv.del(key)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'unavailable' }
      }
    },

    /** Re-key an image (a wall draft becomes the saved artwork's image). A no-op when there is nothing to move. */
    async move(from: string, to: string): Promise<OpResult> {
      if (from === to) return { ok: true }
      try {
        const raw = await kv.get(from)
        if (raw === undefined || raw === null) return { ok: true }
        await kv.put(to, raw)
        await kv.del(from)
        return { ok: true }
      } catch (e) {
        return { ok: false, reason: isQuota(e) ? 'full' : 'unavailable' }
      }
    },
  }
}

export type ImageStore = ReturnType<typeof createImageStore>

// ---- IndexedDB implementation (browser) ----

const DB_NAME = 'wallsnap-images'
const STORE = 'images'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is unavailable'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const req = fn(tx.objectStore(STORE))
        tx.oncomplete = () => {
          db.close()
          resolve(req.result)
        }
        tx.onerror = () => {
          db.close()
          reject(tx.error ?? new Error('IndexedDB transaction failed'))
        }
        tx.onabort = () => {
          db.close()
          reject(tx.error ?? new Error('IndexedDB transaction aborted'))
        }
      }),
  )
}

export const idbKV: KV = {
  get: (key) => run('readonly', (s) => s.get(key)),
  put: (key, value) => run('readwrite', (s) => s.put(value, key)).then(() => undefined),
  del: (key) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
}
