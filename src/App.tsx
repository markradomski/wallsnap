import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import styles from './App.module.css'
import { ApiError, deleteArtwork, getFloors, getPlan, getStatus, getWall, putArtwork } from './api'
import { Elevation } from './Elevation'
import { clampToWall, round1, validate } from './geometry'
import { DEFAULT_IMAGE_WIDTH_CM, acceptImageFile, decodeImage, frameForRatio, ratioDiffers } from './image'
import { createImageStore, idbKV, itemKey, slotDraftKey } from './imageStore'
import { Inspector, type FieldKey } from './Inspector'
import { deriveSaveState, sameArtwork, type SaveState } from './saveState'
import { useTheme } from './theme'
import { TopBar } from './TopBar'
import type { Artwork, Detached, FloorSummary, PlanContext, WallState } from './types'

// Three.js is only ever reached through this dynamic import: the 2D editor never downloads the 3D renderer.
const Viewer3D = lazy(() => import('./viewer3d/Viewer3D'))

const DEFAULT_ART: Artwork = { width: 60, height: 45, u: 0, v: 120 }
const KEYS: FieldKey[] = ['width', 'height', 'u', 'v']

type Result = { kind: 'ok' | 'error'; text: string }
/** The local artwork image shown for the current wall. `key` is where it is stored (artwork item id, or a wall draft). */
interface ArtImage { key: string; url: string; name: string; width: number; height: number; ratio: number }

/**
 * One artwork on the selected wall. `key` is stable for the life of the slot (the FloorGen id once it has one, else a local
 * id); `id` is FloorGen's persistent item id, null until the artwork has been saved.
 */
interface Slot {
  key: string
  id: string | null
  /** null only for a saved artwork that is no longer on this wall (`detached`). */
  art: Artwork | null
  /** What the editor held when this artwork was last loaded or saved: the reference for "do I have unsaved edits?". */
  base: Artwork | null
  detached: Detached | null
  /** Created with + Add artwork (so it is kept when switching walls even before it is edited). */
  added: boolean
  image: ArtImage | null
}

const slotDirty = (s: Slot) => !!s.art && (!s.base || !sameArtwork(s.art, s.base))
/** Needs saving: a new artwork, or a saved one whose size or place was changed. (A detached one has nothing to save.) */
const slotPending = (s: Slot) => !!s.art && (!s.id || !s.base || !sameArtwork(s.art, s.base))
/** Unsaved work worth keeping while another wall is shown. */
const slotKept = (s: Slot) => slotDirty(s) || (!s.id && s.added)

const DAMAGED = 'The saved image for this artwork could not be read; it may be damaged. Choose a replacement image.'
const STORAGE_OFF = 'Saved images are unavailable in this browser (storage is blocked), so the image cannot be shown.'

const format = (a: Artwork): Record<string, string> => Object.fromEntries(KEYS.map((k) => [k, String(round1(a[k]))]))

const describe = (a: Artwork) =>
  `${round1(a.width)}×${round1(a.height)} cm, horizontal position ${round1(a.u)} cm, bottom elevation ${round1(a.v)} cm`

export function App() {
  const [theme, setTheme] = useTheme()
  const [adapter, setAdapter] = useState('')
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [nav3d, setNav3d] = useState<'orbit' | 'walk'>('orbit')
  const [plan, setPlan] = useState<PlanContext | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [floorId, setFloorId] = useState('')
  const [wallId, setWallId] = useState('')
  const [state, setState] = useState<WallState | null>(null)
  const [slots, setSlots] = useState<Slot[]>([])
  const [selKey, setSelKey] = useState<string | null>(null)
  const [text, setText] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmReload, setConfirmReload] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [partial, setPartial] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const store = useMemo(() => createImageStore(idbKV), [])
  const [imageNote, setImageNote] = useState<string | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [lock, setLock] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const imgToken = useRef(0)
  const localSeq = useRef(0)
  /** Unsaved artworks kept while another wall is shown, by "floor/wall". */
  const stash = useRef(new Map<string, Slot[]>())
  const slotsRef = useRef<Slot[]>([])
  slotsRef.current = slots

  const sel = slots.find((x) => x.key === selKey) ?? null
  const art = sel?.art ?? null
  const base = sel?.base ?? null
  const image = sel?.image ?? null
  const artworkId = sel?.id ?? null
  const detached = sel?.detached ?? null
  const patch = (key: string, p: Partial<Slot>) => setSlots((ss) => ss.map((x) => (x.key === key ? { ...x, ...p } : x)))
  const patchSel = (p: Partial<Slot>) => selKey && patch(selKey, p)
  const setArt = (a: Artwork | null) => patchSel({ art: a })
  const wallKey = (f: string, w: string) => `${f}/${w}`

  const fail = (e: unknown, prefix = '') => {
    const text = e instanceof Error ? e.message : 'Unexpected error'
    if (!prefix && e instanceof ApiError && (e.status === 409 || e.code === 'stale')) setConflict(text)
    else if (!prefix && e instanceof ApiError && e.code === 'partial') setPartial(text)
    else setResult({ kind: 'error', text: prefix + text })
  }

  useEffect(() => {
    Promise.all([getStatus(), getFloors()])
      .then(([s, f]) => {
        setAdapter(s.adapter)
        setProjectId(s.project)
        setViewerUrl(s.viewer3dUrl?.startsWith('https://floorgen.app/') ? s.viewer3dUrl : null)
        setFloors(f)
        const first = f.find((x) => x.walls.some((w) => !w.reserved))
        if (first) setFloorId(first.id)
      })
      .catch((e) => fail(e))
      .finally(() => setLoading(false))
  }, [])

  const revoke = (ss: Slot[]) => ss.forEach((x) => x.image && URL.revokeObjectURL(x.image.url))
  useEffect(() => () => revoke(slotsRef.current), [])

  /** Where an artwork's image lives: its FloorGen id once saved, otherwise a local draft for this wall and slot. */
  const keyFor = (x: Slot, f: string, w: string) => (x.id ? itemKey(projectId, x.id) : slotDraftKey(projectId, f, w, x.key))

  /** Restore every artwork's image from this browser's storage (one decode each; a damaged one is reported, not drawn). */
  const loadImages = (list: Slot[], f: string, w: string) => {
    const token = ++imgToken.current
    for (const x of list) {
      if (!x.art) continue
      const k = keyFor(x, f, w)
      store.get(k).then(async (r) => {
        if (token !== imgToken.current) return
        if (!r.ok) return setImageNote(r.reason === 'corrupt' ? DAMAGED : STORAGE_OFF)
        if (!r.value) return
        try {
          await decodeImage(r.value.blob) // stored bytes can be damaged: never hand them to the canvas undecoded
        } catch {
          if (token === imgToken.current) setImageNote(DAMAGED)
          return
        }
        if (token !== imgToken.current) return
        const { blob, name, width, height } = r.value
        patch(x.key, { image: { key: k, url: URL.createObjectURL(blob), name, width, height, ratio: width / height } })
      })
    }
  }

  // Plan-space geometry for the 3D preview: read-only, fetched only while the 3D view is open, and re-read when the wall or
  // the saved artwork changes (never on a local edit: edits are converted in the browser from this geometry).
  const planKey = state ? `${state.wall.floorId}/${state.wall.id}/${artworkId ?? ''}/${state.rev}` : ''
  useEffect(() => {
    if (view !== '3d' || !state) return
    let cancelled = false
    setPlanError(null)
    getPlan(state.wall.floorId, state.wall.id, artworkId)
      .then((p) => !cancelled && setPlan(p))
      .catch((e: unknown) => {
        if (cancelled) return
        setPlan(null)
        setPlanError(e instanceof Error ? e.message : 'Unexpected error')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, planKey])

  const clearOutcome = () => {
    setResult(null)
    setConflict(null)
    setPartial(null)
    setVerified(false)
    setConfirmReload(false)
    setConfirmDelete(false)
  }

  const placeholder = (w: WallState['wall'], offset = 0): Slot => ({
    key: 'draft', id: null, detached: null, added: false, image: null,
    art: clampToWall(w, { ...DEFAULT_ART, u: w.length / 2 + offset }),
    base: clampToWall(w, { ...DEFAULT_ART, u: w.length / 2 + offset }),
  })

  /**
   * Replace the editor with FloorGen's artworks for this wall. `keep` are unsaved artworks from this browser that stay as they
   * are (edits to a saved one, and new ones); everything else is exactly what FloorGen holds.
   */
  const show = (s: WallState, keep: Slot[] = [], prefer: string | null = null) => {
    clearOutcome()
    revoke(slotsRef.current)
    // A response without the list (an older server) still describes at most one artwork, in the original fields.
    const onWall = s.artworks ?? (s.artwork && s.artworkId ? [{ id: s.artworkId, artwork: s.artwork }] : [])
    const list: Slot[] = onWall.map((a) => ({ key: a.id, id: a.id, art: a.artwork, base: a.artwork, detached: null, added: false, image: null }))
    if (s.detached && s.artworkId && !list.some((x) => x.id === s.artworkId)) {
      // Saved, but not on this wall: nothing is drawn and no position is invented.
      list.push({ key: s.artworkId, id: s.artworkId, art: null, base: null, detached: s.detached, added: false, image: null })
    }
    for (const k of keep) {
      const at = list.findIndex((x) => x.key === k.key)
      if (at >= 0) {
        if (k.art && list[at].art) list[at] = { ...list[at], art: k.art }
      } else if (!k.id) list.push({ ...k, image: null })
    }
    if (!list.length) list.push(placeholder(s.wall))
    const chosen = list.find((x) => x.key === prefer) ?? list[0]
    setState(s)
    setSlots(list)
    setSelKey(chosen.key)
    setText(chosen.art ? format(chosen.art) : {}) // same update as the artwork, so the inputs are never empty or stale
    setImageNote(null)
    loadImages(list, s.wall.floorId, s.wall.id)
  }

  const stashCurrent = () => {
    if (!state) return
    const keep = slotsRef.current.filter(slotKept)
    const k = wallKey(state.wall.floorId, state.wall.id)
    if (keep.length) stash.current.set(k, keep)
    else stash.current.delete(k)
  }

  const load = (fId: string, wId: string) => {
    if (!fId || !wId) return
    setLoading(true)
    clearOutcome()
    getWall(fId, wId)
      .then((s) => {
        const k = wallKey(fId, wId)
        const keep = stash.current.get(k) ?? []
        stash.current.delete(k)
        show(s, keep)
      })
      .catch((e) => {
        setState(null)
        setSlots([])
        setSelKey(null)
        fail(e)
      })
      .finally(() => setLoading(false))
  }

  /** Any edit makes the displayed state unsaved: an earlier success or save error no longer describes it. */
  const edit = (a: Artwork, syncText = true) => {
    setArt(a)
    if (syncText) setText(format(a)) // drag, resize and nudge write the inputs in the same update
    setResult(null)
    setVerified(false)
    setConfirmReload(false)
  }
  const typed = (key: FieldKey, value: string) => {
    setText((t) => ({ ...t, [key]: value }))
    const n = Number(value)
    if (!(value.trim() !== '' && Number.isFinite(n) && art)) return
    if (image && lock && (key === 'width' || key === 'height') && n > 0) {
      // Locked proportions: the other dimension follows, using the frame's current ratio.
      const ratio = art.width / art.height
      const next = { ...art, [key]: n, ...(key === 'width' ? { height: round1(n / ratio) } : { width: round1(n * ratio) }) }
      edit(next, false)
      setText({ ...format(next), [key]: value }) // the other dimension follows; what is being typed stays as typed
      return
    }
    edit({ ...art, [key]: n }, false) // keep what is being typed
  }
  const parsed = useMemo(
    () => Object.fromEntries(KEYS.map((k) => [k, text[k] === undefined || text[k].trim() === '' ? NaN : Number(text[k])])) as unknown as Artwork,
    [text],
  )
  const problems = state && art ? validate(state.wall, parsed) : []
  /** Local edits that Reload would throw away (also true for a draft that puts a detached artwork back). */
  const dirty = !!art && (!base || !sameArtwork(parsed, base))
  /** Any artwork on this wall with local work that a reload would throw away. */
  const anyDirty = dirty || slots.some((x) => x.key !== selKey && slotKept(x))

  /**
   * The artwork as the editor holds it right now. The selected one is read from the typed inputs (which may be mid-edit);
   * the others from their slots.
   */
  const currentArt = (x: Slot): Artwork | null => (x.key === selKey ? (x.art ? parsed : null) : x.art)
  const pendingSlots = slots.filter(slotPending)
  /** Every pending artwork is checked against the wall (bounds, doors, windows) before anything is sent. */
  const pendingProblems = new Map<string, string[]>()
  if (state) for (const x of pendingSlots) {
    const a = currentArt(x)
    const p = a ? validate(state.wall, a) : []
    if (p.length) pendingProblems.set(x.key, p)
  }
  const labelOf = (x: Slot) => `${x.image?.name ?? 'Untitled artwork'} (${slots.indexOf(x) + 1})`

  /**
   * Save every pending artwork on this wall, one after another (never in parallel: each write carries the revision the one
   * before it produced). Each is verified by FloorGen's read-back before the next starts. If one fails, the ones already saved
   * stay saved, the rest stay pending, and the message says which is which.
   */
  const apply = async () => {
    if (!state || saving || deleting || reloading || conflict || partial || !pendingSlots.length || pendingProblems.size) return
    const queue = pendingSlots.map((x) => ({ slot: x, art: currentArt(x)! }))
    setSaving(true)
    clearOutcome()
    let rev = state.rev
    const saved: string[] = []
    let created = 0
    let updated = 0
    let lastRev = rev
    try {
      for (const [i, { slot, art: a }] of queue.entries()) {
        let r
        try {
          // A slot without a FloorGen id is a new artwork: it is created, never merged into one already on the wall.
          r = await putArtwork(state.wall.floorId, state.wall.id, a, rev, slot.id, !slot.id)
        } catch (e) {
          const rest = queue.slice(i).map((q) => labelOf(q.slot))
          const progress = `${saved.length ? `Saved: ${saved.join(', ')}. ` : 'Nothing was saved. '}Still pending: ${rest.join(', ')}.`
          const text = e instanceof Error ? e.message : 'Unexpected error'
          if (e instanceof ApiError && (e.status === 409 || e.code === 'stale')) setConflict(`${text} ${progress}`)
          else if (e instanceof ApiError && e.code === 'partial') setPartial(`${text} ${progress}`)
          else setResult({ kind: 'error', text: `${labelOf(slot)} could not be saved: ${text} ${progress}` })
          break
        }
        rev = r.rev
        lastRev = r.rev
        if (r.created) created++
        else updated++
        // The artwork now has a persistent id: its draft image becomes that artwork's image (local only).
        const newKey = itemKey(projectId, r.artworkId)
        let nextImage = slot.image
        if (slot.image && slot.image.key !== newKey) {
          const moved = await store.move(slot.image.key, newKey)
          nextImage = { ...slot.image, key: newKey }
          if (!moved.ok) setImageNote('An image is shown now but could not be kept for later in this browser storage.')
        }
        saved.push(labelOf(slot))
        // Recorded at once: if a later one fails, this one is already saved under its id and is never created twice.
        patch(slot.key, { id: r.artworkId, art: r.artwork, base: r.artwork, detached: null, added: false, image: nextImage })
        if (slot.key === selKey) setText(format(r.artwork))
        setState((st) => (st ? { ...st, rev: r.rev } : st))
        if (i === queue.length - 1) {
          setVerified(true)
          const what = [created && `${created} created`, updated && `${updated} updated`].filter(Boolean).join(', ')
          setResult({
            kind: 'ok',
            text: queue.length === 1
              ? `Verified in FloorGen: ${r.created ? 'created' : 'updated'} artwork ${describe(r.artwork)}. Re-read from FloorGen after saving (revision ${r.rev}).`
              : `Saved all ${queue.length} pending artworks (${what}), each read back from FloorGen and verified (revision ${lastRev}).`,
          })
        }
      }
    } finally {
      setSaving(false)
    }
  }

  // ---- several artworks on one wall ----

  const select = (key: string) => {
    if (key === selKey || saving || deleting) return
    const next = slots.find((x) => x.key === key)
    if (!next) return
    clearOutcome()
    setSelKey(key)
    setText(next.art ? format(next.art) : {}) // each artwork keeps its own edits in its slot, so nothing is lost by switching
    setImageNote(null)
  }

  /** Another artwork on this wall: default size, near the middle (nudged so a second one is not hidden under the first). */
  const addArtwork = () => {
    if (!state || saving || deleting) return
    const key = `new-${++localSeq.current}`
    const n = slots.filter((x) => x.art).length
    const a = clampToWall(state.wall, { width: 60, height: 45, u: state.wall.length / 2 + 15 * (n % 5), v: Math.max(0, (state.wall.height - 45) / 2 - 10 * (n % 5)) })
    clearOutcome()
    setSlots((ss) => [...ss, { key, id: null, art: a, base: a, detached: null, added: true, image: null }])
    setSelKey(key)
    setText(format(a))
    setImageNote(null)
  }

  const dropSlot = (key: string, to?: string | null) => {
    const rest = slotsRef.current.filter((x) => x.key !== key)
    const gone = slotsRef.current.find((x) => x.key === key)
    if (gone?.image) URL.revokeObjectURL(gone.image.url)
    const nextSlots = rest.length ? rest : state ? [placeholder(state.wall)] : []
    const next = nextSlots.find((x) => x.key === to) ?? nextSlots[0]
    setSlots(nextSlots)
    setSelKey(next?.key ?? null)
    setText(next?.art ? format(next.art) : {})
  }

  /** Delete the selected artwork: an unsaved one is simply discarded; a saved one asks first, then goes to FloorGen's trash. */
  const removeSelected = () => {
    if (!sel || saving || deleting) return
    if (!sel.id) {
      void store.remove(keyFor(sel, state?.wall.floorId ?? '', state?.wall.id ?? ''))
      clearOutcome()
      dropSlot(sel.key)
      return
    }
    setConfirmDelete(true)
  }
  const doDelete = () => {
    if (!state || !sel?.id) return
    const slot = sel
    setConfirmDelete(false)
    setDeleting(true)
    clearOutcome()
    deleteArtwork(state.wall.floorId, state.wall.id, slot.id!, state.rev)
      .then(async (r) => {
        await store.remove(itemKey(projectId, slot.id!)) // its image association goes with it; other artworks' images are untouched
        const keep = slotsRef.current.filter((x) => x.key !== slot.key && slotKept(x))
        dropSlot(slot.key)
        // Refresh the wall from FloorGen, keeping every other artwork's unsaved work.
        const fresh = await getWall(state.wall.floorId, state.wall.id)
        show(fresh, keep)
        setResult({ kind: 'ok', text: `Deleted from FloorGen (moved to its trash). Revision ${r.rev}.` })
      })
      .catch((e) => fail(e, 'Could not delete: '))
      .finally(() => setDeleting(false))
  }

  /** Re-read the saved artwork by its FloorGen id. Read-only; on any failure the local state is left exactly as it was. */
  const doReload = () => {
    if (!state) return
    setConfirmReload(false)
    setReloading(true)
    getWall(state.wall.floorId, state.wall.id, artworkId ?? undefined)
      .then((s) => show(s, [], selKey)) // reloading discards local edits to every artwork on this wall
      .catch((e) => fail(e, 'Could not reload from FloorGen: '))
      .finally(() => setReloading(false))
  }
  const reload = () => {
    if (!state || reloading || saving || loading) return
    if (anyDirty) setConfirmReload(true) // never discard edits silently
    else doReload()
  }

  /** Recovery for a detached artwork: draft it back onto this wall; Apply then moves the same FloorGen object. */
  const placeBack = () => {
    const d = detached
    if (!state || !d) return
    edit(clampToWall(state.wall, { width: d.width, height: d.height, u: state.wall.length / 2, v: d.elevation }))
  }

  /** Choose or replace the selected artwork's image. Validation failures leave any existing image untouched. */
  const pickImage = async (file: File) => {
    if (!sel || !state) return
    const slot = sel
    const imageKey = keyFor(slot, state.wall.floorId, state.wall.id)
    setImageBusy(true)
    setImageNote(null)
    try {
      const accepted = await acceptImageFile(file)
      if (!accepted.ok) return setImageNote(accepted.message)
      const { blob, name, type, width, height } = accepted
      const saved = await store.put(imageKey, { blob, name, type, width, height })
      if (!saved.ok) {
        setImageNote(saved.reason === 'full'
          ? 'Browser storage is full: the image is shown now but will not be there after a reload.'
          : 'Browser storage is unavailable: the image is shown now but will not be there after a reload.')
      }
      if (slot.image) URL.revokeObjectURL(slot.image.url)
      const img = { key: imageKey, url: URL.createObjectURL(blob), name, width, height, ratio: width / height }
      setLock(true)
      if (slot.art) {
        // Frame from the image's aspect ratio (pixels do not mean centimetres): a first image on a fresh draft gets the
        // default width; an existing or already-edited artwork keeps its current width.
        const keepWidth = !!slot.id || (!!slot.base && !sameArtwork(slot.art, slot.base))
        const frame = frameForRatio(state.wall, width / height, keepWidth ? slot.art.width : DEFAULT_IMAGE_WIDTH_CM)
        const next = clampToWall(state.wall, { ...slot.art, ...frame })
        patch(slot.key, { image: img, art: next })
        setText(format(next))
        setResult(null)
        setVerified(false)
        setConfirmReload(false)
      } else {
        patch(slot.key, { image: img })
      }
    } finally {
      setImageBusy(false)
    }
  }
  const matchRatio = () => {
    if (!state || !art || !image) return
    edit(clampToWall(state.wall, { ...art, ...frameForRatio(state.wall, image.ratio, art.width) }))
  }

  const own = deriveSaveState({
    hasWall: !!state, loading, saving, conflict: !!conflict, partial: !!partial, error: result?.kind === 'error',
    detached: !!detached, hasItem: !!artworkId,
    problems: problems.length, baseline: sel?.id ? base : null, current: art, verified,
  })
  // Another artwork on this wall with pending changes means the wall as a whole is not saved, whatever the selected one says.
  const save: SaveState = (own === 'synced' || own === 'verified') && pendingSlots.length ? 'unsaved' : own

  const detail =
    conflict ?? partial ??
    result?.text ??
    ({
      none: 'Choose a floor and a wall to begin.',
      loading: 'Reading from FloorGen…',
      saving: 'Writing to FloorGen, then reading it back to verify…',
      new: 'This wall has no WallSnap artwork yet. Applying creates one.',
      unsaved: 'Your edits are local until you apply them.',
      synced: state ? `This matches what FloorGen held at revision ${state.rev}.` : '',
      detached: detached?.message ?? '',
      verified: '',
      conflict: '',
      partial: '',
      error: '',
      invalid: '',
    } as const)[save]

  const onFloor = (id: string) => {
    stashCurrent()
    revoke(slotsRef.current)
    setFloorId(id)
    setWallId('')
    setState(null)
    setSlots([])
    setSelKey(null)
    clearOutcome()
  }
  const onWall = (id: string) => {
    stashCurrent()
    setWallId(id)
    load(floorId, id)
  }
  const wallLabel = floors.find((f) => f.id === floorId)?.walls.find((w) => w.id === wallId)?.label ?? ''

  return (
    <div className={styles.app}>
      <TopBar floors={floors} floorId={floorId} wallId={wallId} onFloor={onFloor} onWall={onWall} save={save} theme={theme} onTheme={setTheme} />
      {adapter === 'mock' && <p className={styles.mock}>MOCK ADAPTER: in-memory data, not connected to FloorGen.</p>}

      <div className={styles.workspace}>
        <main className={styles.editor}>
          {state ? (
            <>
              <div className={styles.toolbar}>
                <div className={styles.meta}>
                  {wallLabel && <span className={styles.wallName} title={wallLabel} data-testid="wall-name">{wallLabel}</span>}
                  <span data-testid="wall-dims">Wall: {round1(state.wall.length)} × {round1(state.wall.height)} cm</span>
                  <span>Endpoint A is at the left</span>
                </div>
                <div className={styles.views} role="group" aria-label="View">
                  {(['2d', '3d'] as const).map((v) => (
                    <button key={v} type="button" aria-pressed={view === v} data-testid={`view-${v}`} onClick={() => { setView(v); if (v === '2d') setNav3d('orbit') }}>{v.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              {view === '2d' ? (
                <div className={styles.stage}>
                  <div className={styles.canvas} style={{ ['--aspect' as string]: state.wall.length / state.wall.height }}>
                    <Elevation
                      wall={state.wall}
                      artwork={art}
                      image={image?.url ?? null}
                      lockRatio={!!image && lock}
                      selectionKey={selKey}
                      others={slots.filter((x) => x.key !== selKey && x.art).map((x) => ({ key: x.key, artwork: x.art!, image: x.image?.url ?? null }))}
                      onSelect={select}
                      onImageError={() => { if (sel?.image) URL.revokeObjectURL(sel.image.url); patchSel({ image: null }); setImageNote(DAMAGED) }}
                      onChange={edit}
                    />
                  </div>
                </div>
              ) : (
                <div className={styles.stage3d}>
                  <Suspense fallback={<p className={styles.empty} role="status">Loading the 3D viewer…</p>}>
                    <Viewer3D
                      project={projectId}
                      // Only a plan that belongs to the wall on screen: never draw one wall's geometry on another.
                      plan={plan && plan.wall.id === state.wall.id && plan.floorId === state.wall.floorId ? plan : null}
                      planError={planError}
                      art={art}
                      imageUrl={image?.url ?? null}
                      unsaved={!!art && (!sel?.id || !base || !sameArtwork(art, base))}
                      // The other artworks on this wall, as they are in the editor right now (unsaved ones included).
                      localOthers={slots.filter((x) => x.key !== selKey && x.art).map((x) => ({ key: x.key, id: x.id, art: x.art!, imageUrl: x.image?.url ?? null }))}
                      nav={nav3d}
                      onNav={setNav3d}
                    />
                  </Suspense>
                </div>
              )}
            </>
          ) : (
            <p className={styles.empty}>{loading ? 'Loading…' : 'Select a floor and wall in the bar above to start placing artwork.'}</p>
          )}
        </main>

        {state && (
          <Inspector
            text={text}
            disabled={!art}
            valid={Object.fromEntries(KEYS.map((k) => [k, !art || Number.isFinite(parsed[k])])) as Record<FieldKey, boolean>}
            onType={typed}
            problems={problems}
            save={save}
            detail={detail}
            detached={detached}
            artworks={slots.map((x) => ({
              key: x.key,
              label: x.image?.name ?? 'Untitled artwork',
              thumb: x.image?.url ?? null,
              status: x.detached ? 'detached' : pendingProblems.has(x.key) ? 'invalid' : !x.id ? 'new' : slotPending(x) ? 'unsaved' : 'saved',
              problems: x.key === selKey ? [] : (pendingProblems.get(x.key) ?? []), // the selected one's problems are in the status card already
            }))}
            selectedKey={selKey}
            onSelect={select}
            onAdd={addArtwork}
            onDelete={removeSelected}
            confirmDelete={confirmDelete}
            onConfirmDelete={doDelete}
            onCancelDelete={() => setConfirmDelete(false)}
            deleting={deleting}
            canDelete={!!sel && !saving && !deleting && !loading && !reloading}
            canAdd={!saving && !deleting && !loading && !reloading}
            onPlaceBack={placeBack}
            canApply={pendingSlots.length > 0 && pendingProblems.size === 0 && !saving && !deleting && !loading && !reloading && !conflict && !partial}
            pendingCount={pendingSlots.length}
            blockedNote={pendingProblems.size ? `Fix ${pendingProblems.size === 1 ? 'the artwork' : `${pendingProblems.size} artworks`} marked below to apply: ${[...pendingProblems.keys()].map((k) => labelOf(slots.find((x) => x.key === k)!)).join(', ')}.` : null}
            onApply={apply}
            reloading={reloading}
            canReload={!loading && !saving && !reloading}
            onReload={reload}
            confirmReload={confirmReload}
            onDiscardAndReload={doReload}
            onKeepEditing={() => setConfirmReload(false)}
            viewerUrl={viewerUrl}
            image={image}
            imageNote={imageNote}
            imageBusy={imageBusy}
            onPickImage={pickImage}
            lockRatio={lock}
            onLockRatio={setLock}
            ratioMismatch={!!image && !!art && ratioDiffers(parsed.width, parsed.height, image.ratio)}
            onMatchRatio={matchRatio}
          />
        )}
      </div>
    </div>
  )
}
