import { describe, expect, it } from 'vitest'
import { createImageStore, draftKey, itemKey, type KV } from './imageStore'

const png = (bytes = 4) => new Blob([new Uint8Array(bytes).fill(1)], { type: 'image/png' })
const image = (extra: Partial<{ blob: Blob; name: string; width: number; height: number }> = {}) => ({
  blob: png(), name: 'a.png', type: 'image/png', width: 800, height: 600, ...extra,
})

const memory = () => {
  const map = new Map<string, unknown>()
  const kv: KV = {
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
  }
  return { map, kv }
}
const broken = (error: Error): KV => ({
  get: () => Promise.reject(error),
  put: () => Promise.reject(error),
  del: () => Promise.reject(error),
})

describe('image keys', () => {
  it('tie an image to the project and the persistent artwork id, or to a wall draft', () => {
    expect(itemKey('p_dev', 'i_1')).toBe('p_dev/item/i_1')
    expect(draftKey('p_dev', 'f_1', 'w_1')).toBe('p_dev/draft/f_1/w_1')
    expect(itemKey('p_dev', 'i_1')).not.toBe(itemKey('p_other', 'i_1'))
    expect(itemKey('p_dev', 'i_1')).not.toBe(draftKey('p_dev', 'f_1', 'w_1'))
  })
})

describe('image store', () => {
  it('round-trips an image', async () => {
    const store = createImageStore(memory().kv)
    expect((await store.put('k', image())).ok).toBe(true)
    const got = await store.get('k')
    expect(got.ok && got.value).toMatchObject({ name: 'a.png', width: 800, height: 600, type: 'image/png' })
    expect(got.ok && got.value?.blob.size).toBe(4)
  })

  it('reports nothing stored as ok/null, not as an error', async () => {
    expect(await createImageStore(memory().kv).get('nope')).toEqual({ ok: true, value: null })
  })

  it('replacing an image overwrites the previous one', async () => {
    const store = createImageStore(memory().kv)
    await store.put('k', image({ name: 'first.png', width: 100, height: 100 }))
    await store.put('k', image({ name: 'second.png', width: 300, height: 200, blob: png(9) }))
    const got = await store.get('k')
    expect(got.ok && got.value).toMatchObject({ name: 'second.png', width: 300, height: 200 })
    expect(got.ok && got.value?.blob.size).toBe(9)
  })

  it.each([
    ['a non-object', 42],
    ['a record with no blob', { name: 'x', type: 'image/png', width: 1, height: 1, savedAt: 1 }],
    ['an empty blob', { ...image({ blob: new Blob([]) }), savedAt: 1 }],
    ['bad dimensions', { ...image({ width: 0 }), savedAt: 1 }],
    ['a blob that is really a string', { ...image(), blob: 'data:image/png;base64,AAAA', savedAt: 1 }],
  ])('treats %s as corrupt, never as data to display', async (_name, bad) => {
    const m = memory()
    m.map.set('k', bad)
    expect(await createImageStore(m.kv).get('k')).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('reports unavailable storage instead of throwing', async () => {
    const store = createImageStore(broken(new Error('blocked')))
    expect(await store.get('k')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await store.put('k', image())).toEqual({ ok: false, reason: 'unavailable' })
    expect(await store.remove('k')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await store.move('a', 'b')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('distinguishes a full disk from unavailable storage', async () => {
    const q = new Error('The quota has been exceeded.')
    q.name = 'QuotaExceededError'
    expect(await createImageStore(broken(q)).put('k', image())).toEqual({ ok: false, reason: 'full' })
  })

  it('moves a wall draft to the saved artwork id, leaving nothing behind', async () => {
    const m = memory()
    const store = createImageStore(m.kv)
    const draft = draftKey('p', 'f', 'w')
    const item = itemKey('p', 'i_9')
    await store.put(draft, image({ name: 'draft.png' }))
    expect((await store.move(draft, item)).ok).toBe(true)
    expect(m.map.has(draft)).toBe(false)
    const got = await store.get(item)
    expect(got.ok && got.value?.name).toBe('draft.png')
  })

  it('moving when there is no draft, or to the same key, is a harmless no-op', async () => {
    const m = memory()
    const store = createImageStore(m.kv)
    expect((await store.move('missing', 'to')).ok).toBe(true)
    expect(m.map.size).toBe(0)
    await store.put('k', image())
    expect((await store.move('k', 'k')).ok).toBe(true)
    expect(m.map.has('k')).toBe(true)
  })

  it('a failed move does not destroy the source image', async () => {
    const m = memory()
    await createImageStore(m.kv).put('from', image())
    const failingPut: KV = { ...m.kv, put: () => Promise.reject(new Error('disk')) }
    expect((await createImageStore(failingPut).move('from', 'to')).ok).toBe(false)
    expect(m.map.has('from')).toBe(true)
  })

  it('removes an image', async () => {
    const m = memory()
    const store = createImageStore(m.kv)
    await store.put('k', image())
    await store.remove('k')
    expect(await store.get('k')).toEqual({ ok: true, value: null })
  })
})
