import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import styles from './App.module.css'
import { ApiError, getFloors, getPlan, getStatus, getWall, putArtwork } from './api'
import { Elevation } from './Elevation'
import { clampToWall, round1, validate } from './geometry'
import { DEFAULT_IMAGE_WIDTH_CM, acceptImageFile, decodeImage, frameForRatio, ratioDiffers } from './image'
import { createImageStore, draftKey, idbKV, itemKey } from './imageStore'
import { Inspector, type FieldKey } from './Inspector'
import { deriveSaveState, sameArtwork } from './saveState'
import { useTheme } from './theme'
import { TopBar } from './TopBar'
import type { Artwork, FloorSummary, PlanContext, WallState } from './types'

// Three.js is only ever reached through this dynamic import: the 2D editor never downloads the 3D renderer.
const Viewer3D = lazy(() => import('./viewer3d/Viewer3D'))

const DEFAULT_ART: Artwork = { width: 60, height: 45, u: 0, v: 120 }
const KEYS: FieldKey[] = ['width', 'height', 'u', 'v']

type Result = { kind: 'ok' | 'error'; text: string }
/** The local artwork image shown for the current wall. `key` is where it is stored (artwork item id, or a wall draft). */
interface ArtImage { key: string; url: string; name: string; width: number; height: number; ratio: number }

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
  const [plan, setPlan] = useState<PlanContext | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [projectId, setProjectId] = useState('')
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [floorId, setFloorId] = useState('')
  const [wallId, setWallId] = useState('')
  const [state, setState] = useState<WallState | null>(null)
  const [art, setArt] = useState<Artwork | null>(null)
  /** What the editor held when it was last loaded or saved: the reference for "do I have unsaved edits?". */
  const [base, setBase] = useState<Artwork | null>(null)
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
  const [image, setImage] = useState<ArtImage | null>(null)
  const [imageNote, setImageNote] = useState<string | null>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const [lock, setLock] = useState(true)
  const shownKey = useRef<string | null>(null)
  const urlRef = useRef<string | null>(null)

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

  /** Show (or clear) the image, releasing the previous object URL only if it is really being replaced. */
  const showImage = (img: ArtImage | null) => {
    if (urlRef.current && urlRef.current !== img?.url) URL.revokeObjectURL(urlRef.current)
    urlRef.current = img?.url ?? null
    shownKey.current = img?.key ?? null
    setImage(img)
  }
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  /** Where this wall's image lives: the saved artwork's id once it has one, otherwise a local draft for the wall. */
  const imageKey = projectId && state
    ? state.artworkId ? itemKey(projectId, state.artworkId) : draftKey(projectId, state.wall.floorId, state.wall.id)
    : null

  useEffect(() => {
    if (!imageKey) {
      showImage(null)
      setImageNote(null)
      return
    }
    if (shownKey.current === imageKey) return // already showing it (e.g. a draft that Apply just re-keyed)
    let cancelled = false
    showImage(null)
    setImageNote(null)
    store.get(imageKey).then(async (r) => {
      if (cancelled) return
      if (!r.ok) return setImageNote(r.reason === 'corrupt' ? DAMAGED : STORAGE_OFF)
      if (!r.value) return
      try {
        await decodeImage(r.value.blob) // stored bytes can be damaged: never hand them to the canvas undecoded
      } catch {
        if (!cancelled) setImageNote(DAMAGED)
        return
      }
      if (cancelled) return
      const { blob, name, width, height } = r.value
      showImage({ key: imageKey, url: URL.createObjectURL(blob), name, width, height, ratio: width / height })
    })
    return () => { cancelled = true }
  }, [imageKey, store])

  // Plan-space geometry for the 3D preview: read-only, fetched only while the 3D view is open, and re-read when the wall or
  // the saved artwork changes (never on a local edit: edits are converted in the browser from this geometry).
  const planKey = state ? `${state.wall.floorId}/${state.wall.id}/${state.artworkId ?? ''}/${state.rev}` : ''
  useEffect(() => {
    if (view !== '3d' || !state) return
    let cancelled = false
    setPlanError(null)
    getPlan(state.wall.floorId, state.wall.id, state.artworkId)
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
  }

  /** Replace the whole editor with FloorGen's state: artwork, numeric inputs, reference copy and revision together. */
  const show = (s: WallState) => {
    clearOutcome()
    setState(s)
    if (s.detached) {
      // Saved, but not on this wall: nothing is drawn and no position is invented.
      setArt(null)
      setBase(null)
      setText({})
      return
    }
    const initial = s.artwork ?? clampToWall(s.wall, { ...DEFAULT_ART, u: s.wall.length / 2 })
    setArt(initial)
    setBase(initial)
    setText(format(initial)) // same update as the artwork, so the inputs are never empty or stale
  }

  const load = (fId: string, wId: string) => {
    if (!fId || !wId) return
    setLoading(true)
    clearOutcome()
    getWall(fId, wId)
      .then(show)
      .catch((e) => {
        setState(null)
        setArt(null)
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

  const apply = () => {
    if (!state || !art || problems.length || saving || reloading || conflict || partial) return
    setSaving(true)
    clearOutcome()
    putArtwork(state.wall.floorId, state.wall.id, parsed, state.rev, state.artworkId)
      .then(async (r) => {
        // The artwork now has a persistent id: a wall draft image becomes that artwork's image (local only).
        const newKey = itemKey(projectId, r.artworkId)
        if (image && image.key !== newKey) {
          const moved = await store.move(image.key, newKey)
          showImage({ ...image, key: newKey })
          if (!moved.ok) setImageNote('The image is shown now but could not be kept for later in this browser storage.')
        }
        setState({ ...state, rev: r.rev, artwork: r.artwork, artworkId: r.artworkId, detached: null })
        setArt(r.artwork)
        setBase(r.artwork)
        setText(format(r.artwork))
        setVerified(true)
        setResult({ kind: 'ok', text: `Verified in FloorGen: ${r.created ? 'created' : 'updated'} artwork ${describe(r.artwork)}. Re-read from FloorGen after saving (revision ${r.rev}).` })
      })
      .catch((e) => fail(e))
      .finally(() => setSaving(false))
  }

  /** Re-read the saved artwork by its FloorGen id. Read-only; on any failure the local state is left exactly as it was. */
  const doReload = () => {
    if (!state) return
    setConfirmReload(false)
    setReloading(true)
    getWall(state.wall.floorId, state.wall.id, state.artworkId ?? undefined)
      .then(show)
      .catch((e) => fail(e, 'Could not reload from FloorGen: '))
      .finally(() => setReloading(false))
  }
  const reload = () => {
    if (!state || reloading || saving || loading) return
    if (dirty) setConfirmReload(true) // never discard edits silently
    else doReload()
  }

  /** Recovery for a detached artwork: draft it back onto this wall; Apply then moves the same FloorGen object. */
  const placeBack = () => {
    const d = state?.detached
    if (!state || !d) return
    edit(clampToWall(state.wall, { width: d.width, height: d.height, u: state.wall.length / 2, v: d.elevation }))
  }

  /** Choose or replace the artwork image. Validation failures leave any existing image untouched. */
  const pickImage = async (file: File) => {
    if (!imageKey || !state) return
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
      showImage({ key: imageKey, url: URL.createObjectURL(blob), name, width, height, ratio: width / height })
      setLock(true)
      if (art) {
        // Frame from the image's aspect ratio (pixels do not mean centimetres): a first image on a fresh draft gets the
        // default width; an existing or already-edited artwork keeps its current width.
        const keepWidth = !!state.artworkId || (!!base && !sameArtwork(art, base))
        const frame = frameForRatio(state.wall, width / height, keepWidth ? art.width : DEFAULT_IMAGE_WIDTH_CM)
        edit(clampToWall(state.wall, { ...art, ...frame }))
      }
    } finally {
      setImageBusy(false)
    }
  }
  const matchRatio = () => {
    if (!state || !art || !image) return
    edit(clampToWall(state.wall, { ...art, ...frameForRatio(state.wall, image.ratio, art.width) }))
  }

  const save = deriveSaveState({
    hasWall: !!state, loading, saving, conflict: !!conflict, partial: !!partial, error: result?.kind === 'error',
    detached: !!state?.detached, hasItem: !!state?.artworkId,
    problems: problems.length, baseline: state?.artwork ?? null, current: art, verified,
  })

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
      detached: state?.detached?.message ?? '',
      verified: '',
      conflict: '',
      partial: '',
      error: '',
      invalid: '',
    } as const)[save]

  const onFloor = (id: string) => {
    setFloorId(id)
    setWallId('')
    setState(null)
    setArt(null)
    clearOutcome()
  }
  const onWall = (id: string) => {
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
                    <button key={v} type="button" aria-pressed={view === v} data-testid={`view-${v}`} onClick={() => setView(v)}>{v.toUpperCase()}</button>
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
                      onImageError={() => { showImage(null); setImageNote(DAMAGED) }}
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
                      unsaved={!!art && (!state.artwork || !sameArtwork(art, state.artwork))}
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
            detached={state.detached}
            onPlaceBack={placeBack}
            canApply={!!art && !problems.length && !saving && !loading && !reloading && !conflict && !partial}
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
