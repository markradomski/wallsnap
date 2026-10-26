/**
 * The 3D preview panel. Loaded lazily (it is the only way Three.js reaches the browser), so the 2D editor never pays for it.
 * It shows the imported townhouse model with the artwork's CURRENT local state: unsaved edits appear immediately, and nothing
 * here can write to FloorGen. State that matters (artwork, image, selected wall) stays in the App; this panel only draws it.
 */
import { useEffect, useRef, useState } from 'react'
import { idbModelStore, type StoredModel } from './modelStore'
import { checkModelBytes, wallFitsModel } from './modelCheck'
import { groupIndexFor, hasUpperFloors, visibleGroups, type FloorMode } from './floors'
import { describeMatch } from './matching'
import { localPlanItem } from './plan'
import { DEFAULT_DEPTH_CM } from './plan'
import { TownhouseScene, WebGLUnavailableError, type ModelReport, type OtherArtwork } from './scene'
import { getArtworks, getWalk } from '../api'
import { idbKV, itemKey, createImageStore } from '../imageStore'
import type { WalkPhase } from './walkMove'
import type { ArtworkCollection, Artwork, PlanContext, WalkData } from '../types'
import styles from './Viewer3D.module.css'

export interface Viewer3DProps {
  project: string
  plan: PlanContext | null
  planError: string | null
  /** WallSnap's current local artwork (including unsaved edits), or null when there is none to show. */
  art: Artwork | null
  /** Object URL of the local artwork image, if any. */
  imageUrl: string | null
  /** True when the local artwork differs from what FloorGen holds (new, edited or not yet applied). */
  unsaved: boolean
  /** The other artworks on the selected wall, as they are in the editor now (unsaved edits and new ones included). */
  localOthers: { key: string; id: string | null; art: Artwork; imageUrl: string | null }[]
  /** Camera mode, kept by the App so it survives the panel being rebuilt when the floor changes (it resets on leaving 3D). */
  nav: 'orbit' | 'walk'
  onNav: (n: 'orbit' | 'walk') => void
}

const HINT_KEY = 'wallsnap.walkHintSeen'
const hintSeen = () => {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

type ModelStatus = 'loading' | 'none' | 'ready' | 'error'

export default function Viewer3D({ project, plan, planError, art, imageUrl, unsaved, localOthers, nav, onNav: setNav }: Viewer3DProps) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<TownhouseScene | null>(null)
  const [ready, setReady] = useState(false)
  const [webglError, setWebglError] = useState<string | null>(null)
  const [status, setStatus] = useState<ModelStatus>('loading')
  const [rec, setRec] = useState<StoredModel | null>(null)
  const [report, setReport] = useState<ModelReport | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [mode, setMode] = useState<FloorMode>('inspect')
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [imageProblem, setImageProblem] = useState(false)
  const [matchNote, setMatchNote] = useState<string | null>(null)
  // Walk mode (a first-person camera on the same scene; read-only, camera only)
  const [phase, setPhase] = useState<WalkPhase>('off')
  const [walkData, setWalkData] = useState<WalkData | null>(null)
  const [walkError, setWalkError] = useState<string | null>(null)
  const [hintDone, setHintDone] = useState(hintSeen)
  const [lockRefused, setLockRefused] = useState(false)
  // Every saved artwork in the project, and each one's locally stored image (by item id).
  const [collection, setCollection] = useState<ArtworkCollection | null>(null)
  const [otherImages, setOtherImages] = useState<Record<string, HTMLImageElement>>({})

  // The renderer: created once per mount, fully disposed on unmount, so toggling 2D/3D never accumulates loops or listeners.
  useEffect(() => {
    if (!host.current) return
    try {
      const s = new TownhouseScene(host.current, setPhase, () => setLockRefused(true))
      scene.current = s
      ;(window as unknown as { __wallsnap3d?: () => unknown }).__wallsnap3d = () => s.debugState()
      // Diagnostics for tests: only ever moves the camera, and refuses spots inside a collider.
      ;(window as unknown as { __wallsnapWalkPlace?: unknown }).__wallsnapWalkPlace = (x: number, y: number, deg: number) => s.walk.debugPlace(x, y, deg)
      setReady(true)
      return () => {
        delete (window as unknown as { __wallsnap3d?: unknown }).__wallsnap3d
        delete (window as unknown as { __wallsnapWalkPlace?: unknown }).__wallsnapWalkPlace
        s.dispose()
        scene.current = null
        setReady(false)
      }
    } catch (e) {
      setWebglError(e instanceof WebGLUnavailableError ? e.message : `3D preview could not start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  // Restore the previously imported model for this project.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setStatus('loading')
    idbModelStore.get(project).then(async (r) => {
      if (cancelled) return
      if (!r.ok) {
        setModelError(r.reason === 'corrupt' ? 'The stored 3D model is damaged. Import it again.' : 'Saved models are unavailable in this browser (storage is blocked), so no model can be restored.')
        return setStatus('error')
      }
      if (!r.value) return setStatus('none')
      try {
        const buf = await r.value.blob.arrayBuffer()
        const rep = await scene.current!.loadModel(buf)
        if (cancelled) return
        setRec(r.value)
        setReport(rep)
        setStatus('ready')
      } catch (e) {
        if (!cancelled) {
          setModelError(`The stored 3D model could not be loaded: ${e instanceof Error ? e.message : 'unreadable'}. Import it again.`)
          setStatus('error')
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [ready, project])

  // The artwork image as a decoded element.
  useEffect(() => {
    setImageProblem(false)
    if (!imageUrl) return setImg(null)
    let cancelled = false
    const el = new Image()
    el.onload = () => !cancelled && setImg(el)
    el.onerror = () => {
      if (cancelled) return
      setImg(null)
      setImageProblem(true)
    }
    el.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [imageUrl])

  // The selected wall's plan geometry. (Re-matching the model's generic artwork and re-framing the camera happen on a new wall.)
  useEffect(() => {
    if (!ready) return
    scene.current?.setPlan(plan)
    setMatchNote(describeMatch(scene.current?.match ?? { status: 'unsaved', candidates: 0 }))
  }, [ready, plan, report])

  // All saved artworks, whatever wall is selected. Read-only; re-read when the project revision moves (e.g. after Apply).
  const planRev = plan?.rev
  useEffect(() => {
    let cancelled = false
    getArtworks().then(
      (c) => !cancelled && setCollection(c),
      () => !cancelled && setCollection(null), // the selected artwork still shows; the others just are not drawn
    )
    return () => {
      cancelled = true
    }
  }, [planRev])

  // Their images come from the same local store the 2D editor uses; none is ever sent anywhere.
  const savedIds = collection?.artworks.map((a) => a.id).join(',') ?? ''
  useEffect(() => {
    if (!savedIds) return setOtherImages({})
    let cancelled = false
    const urls: string[] = []
    const store = createImageStore(idbKV)
    Promise.all(
      savedIds.split(',').map(async (id) => {
        const r = await store.get(itemKey(project, id))
        if (!r.ok || !r.value) return null
        const url = URL.createObjectURL(r.value.blob)
        urls.push(url)
        const el = new Image()
        el.src = url
        try {
          await el.decode()
        } catch {
          return null // unreadable: that artwork shows as a plain frame
        }
        return [id, el] as const
      }),
    ).then((pairs) => {
      if (!cancelled) setOtherImages(Object.fromEntries(pairs.filter((p): p is readonly [string, HTMLImageElement] => p !== null)))
    })
    return () => {
      cancelled = true
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 0)
    }
  }, [savedIds, project])

  // Unsaved edits: only transforms change here; never a rebuild.
  useEffect(() => {
    if (!ready) return
    // Without a model there is nothing for the artwork to hang in, so it is not drawn.
    scene.current?.setArtwork(report && plan && art ? localPlanItem(plan, art) : null, img)
  }, [ready, plan, art, img, report])

  // Floor visibility from the project's floors and the exported groups.
  const selected = report && plan ? groupIndexFor(report.groupNames, plan.floors, plan.floorId) : null
  const count = report?.groupNames.length ?? 0
  const upper = hasUpperFloors(count, selected)
  useEffect(() => {
    if (ready && report) scene.current?.setFloorVisibility(visibleGroups(count, selected, mode))
  }, [ready, report, count, selected, mode])

  // The wall's other artworks come from the editor (their unsaved edits count); decode their images once per picture.
  const [localImages, setLocalImages] = useState<Record<string, HTMLImageElement>>({})
  const localUrls = localOthers.map((o) => o.imageUrl ?? '').join('|')
  useEffect(() => {
    let cancelled = false
    const urls = localUrls.split('|').filter(Boolean)
    Promise.all(
      urls.map(async (u) => {
        const el = new Image()
        el.src = u
        try {
          await el.decode()
        } catch {
          return null
        }
        return [u, el] as const
      }),
    ).then((pairs) => !cancelled && setLocalImages(Object.fromEntries(pairs.filter((p): p is readonly [string, HTMLImageElement] => p !== null))))
    return () => {
      cancelled = true
    }
  }, [localUrls])

  // Everything saved except the artwork being edited (that one is drawn from the editor's own state above), and the wall's
  // other artworks drawn from the editor too, so an unsaved edit or a new artwork shows without any export or save.
  const editedId = plan?.item?.id
  const localSig = JSON.stringify(localOthers.map((o) => [o.key, o.id, o.art, o.imageUrl])) // a new array every render must not redraw the scene
  const onWallIds = localOthers.map((o) => o.id).filter((x): x is string => !!x).join(',')
  useEffect(() => {
    if (!ready || !report || !collection) return scene.current?.setOthers([])
    const skip = new Set([editedId, ...onWallIds.split(',').filter(Boolean)])
    const saved = new Map(collection.artworks.map((a) => [a.id, a]))
    const fromProject = collection.artworks
      .filter((a) => !skip.has(a.id))
      .map((a): OtherArtwork => ({
        id: a.id,
        item: { x: a.x, y: a.y, rotation: a.rotation, width: a.width, height: a.height, depth: a.depth, elevation: a.elevation },
        baseCm: a.baseCm,
        color: a.color,
        wall: a.wall,
        image: otherImages[a.id] ?? null,
        groupIndex: groupIndexFor(report.groupNames, collection.floors, a.floorId),
      }))
    const fromWall = plan
      ? localOthers.map((o): OtherArtwork => {
          const s = o.id ? saved.get(o.id) : undefined
          return {
            id: o.id ?? o.key,
            item: { ...localPlanItem(plan, o.art), depth: s?.depth ?? DEFAULT_DEPTH_CM },
            matchItem: s && { x: s.x, y: s.y, rotation: s.rotation, width: s.width, height: s.height, depth: s.depth, elevation: s.elevation },
            baseCm: plan.baseCm,
            color: s?.color ?? '#4b5a70',
            wall: s ? plan.wall : null,
            image: o.imageUrl ? (localImages[o.imageUrl] ?? null) : null,
            groupIndex: groupIndexFor(report.groupNames, plan.floors, plan.floorId),
          }
        })
      : []
    scene.current?.setOthers([...fromProject, ...fromWall])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, report, collection, editedId, otherImages, plan, localSig, localImages, onWallIds])

  // Walk mode: fetch this storey's collision data (read-only), then hand it to the camera rig.
  const walking = nav === 'walk' && !!report && !!plan
  const floorId = plan?.floorId
  useEffect(() => {
    if (!walking || !floorId) return
    let cancelled = false
    setWalkError(null)
    getWalk(floorId).then(
      (d) => !cancelled && setWalkData(d),
      (e: unknown) => !cancelled && setWalkError(e instanceof Error ? e.message : 'Could not read this floor from FloorGen.'),
    )
    return () => {
      cancelled = true
    }
  }, [walking, floorId, planRev])

  useEffect(() => {
    const rig = scene.current?.walk
    if (!rig) return
    if (!walking) return rig.exit()
    if (rig.phase === 'off') {
      rig.enter()
      host.current?.focus() // keys work straight away, even before the mouse is captured
    }
    if (walkData && plan && walkData.floorId === plan.floorId) {
      rig.setData(walkData, scene.current!.walkTarget(), `${plan.floorId}:${plan.wall.id}`)
      if (rig.start && !rig.start.ok) {
        setWalkError(`Walk mode cannot start here: ${rig.start.reason}`)
        setNav('orbit')
      }
    }
  }, [walking, walkData, plan])

  // Leaving the panel (2D) or changing project always ends Walk mode through the scene's own disposal.
  const locked = phase === 'locked'
  useEffect(() => {
    if (locked && !hintDone) {
      setHintDone(true)
      try {
        localStorage.setItem(HINT_KEY, '1')
      } catch {
        /* the hint just shows again next time */
      }
    }
  }, [locked, hintDone])

  const fit = report && plan ? wallFitsModel(report.bounds, plan.wall.a, plan.wall.b) : null

  async function importModel(file: File) {
    if (!scene.current) return
    setImportError(null)
    setImporting(true)
    try {
      if (!/\.glb$/i.test(file.name)) return setImportError('Choose a .glb file. In FloorGen, export the building as a 3D model (GLB).')
      const buf = await file.arrayBuffer()
      const check = checkModelBytes(new Uint8Array(buf))
      if (!check.ok) return setImportError(check.error)
      let rep: ModelReport
      try {
        rep = await scene.current.loadModel(buf) // atomic: if it cannot be parsed the current model stays
      } catch (e) {
        return setImportError(`The 3D renderer could not read this file (${e instanceof Error ? e.message : 'unreadable'}). Export it from FloorGen again.`)
      }
      const model = { blob: new Blob([buf], { type: 'model/gltf-binary' }), name: file.name, size: file.size, summary: { floors: check.info.floors.length, triangles: check.info.triangles, generator: check.info.generator } }
      const saved = await idbModelStore.put(project, model)
      setRec({ ...model, importedAt: Date.now() })
      setReport(rep)
      setStatus('ready')
      setModelError(null)
      setWarnings([
        ...check.warnings,
        ...(saved.ok ? [] : ['The model is shown now but could not be kept in this browser, so it will not be there after a reload.']),
      ])
    } finally {
      setImporting(false)
    }
  }

  const badge = !art ? 'No artwork on this wall' : unsaved ? 'Previewing unsaved changes' : 'Showing the saved placement'
  const notes = [
    ...(fit ? [fit] : []),
    ...(matchNote ? [matchNote] : []),
    ...warnings,
    ...(art && !imageUrl ? ['No image has been added to this artwork, so it is shown as a plain frame.'] : []),
    ...(imageProblem ? ['The artwork image could not be shown; it is drawn as a plain frame.'] : []),
  ]
  const overlay = webglError
    ? { title: '3D preview is unavailable', text: webglError }
    : planError
      ? { title: 'Could not read this wall from FloorGen', text: planError }
      : status === 'loading'
        ? { title: 'Loading the 3D model…', text: '' }
        : status === 'none'
          ? { title: 'No 3D model yet', text: 'In FloorGen, export your townhouse as a 3D model (GLB), then import it here. WallSnap keeps it in this browser only.' }
          : status === 'error'
            ? { title: 'The 3D model is not available', text: modelError ?? '' }
            : !plan
              ? { title: 'Reading the wall…', text: '' }
              : null

  return (
    <div className={styles.panel} data-testid="viewer3d">
      <div className={styles.bar}>
        <span className={styles.badge} data-unsaved={unsaved && !!art} data-testid="preview-badge">{badge}</span>
        {report && (
          <div className={styles.nav} role="group" aria-label="Camera">
            <button type="button" aria-pressed={nav === 'orbit'} data-testid="nav-orbit" onClick={() => setNav('orbit')}>Orbit</button>
            <button type="button" aria-pressed={nav === 'walk'} data-testid="nav-walk" onClick={() => { setWalkError(null); setNav('walk') }}>Walk</button>
          </div>
        )}
        {nav === 'walk' && (
          <>
            <span className={styles.walkStatus} data-phase={phase} data-testid="walk-status" role="status">
              {phase === 'locked'
                ? 'Mouse captured · Esc releases it'
                : lockRefused
                  ? 'This browser would not capture the mouse · turn with the arrow keys'
                  : 'Click the view to capture the mouse'}
            </span>
            <button type="button" className={styles.exit} data-testid="walk-exit" onClick={() => setNav('orbit')}>Exit Walk</button>
          </>
        )}
        {report && (
          <label className={styles.check} title={upper ? '' : 'There are no floors above the selected one'}>
            <input type="checkbox" checked={mode === 'all' && upper} disabled={!upper} onChange={(e) => setMode(e.target.checked ? 'all' : 'inspect')} />
            Show upper floors
          </label>
        )}
        <span className={styles.spacer} />
        {rec && <span className={styles.modelInfo} data-testid="model-info" title={`${rec.name}, ${(rec.size / 1048576).toFixed(2)} MB`}>{rec.name} · imported {fmtDate(rec.importedAt)}</span>}
        {!webglError && (
          <label className={styles.import} aria-disabled={importing}>
            <input type="file" accept=".glb,model/gltf-binary" className={styles.srOnly} aria-label="3D model file (GLB)" data-testid="model-input" disabled={importing}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void importModel(f)
              }} />
            <span>{importing ? 'Checking model…' : rec ? 'Replace 3D model…' : 'Import 3D model…'}</span>
          </label>
        )}
      </div>
      {nav === 'walk' && !hintDone && (
        <p className={styles.hint} data-testid="walk-hint">
          Walking at eye level (160 cm). <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> move, the mouse looks, <kbd>Shift</kbd> is faster, <kbd>Esc</kbd> releases the mouse. Arrow keys also move and turn.
        </p>
      )}
      {walkError && <p className={styles.error} role="alert" data-testid="walk-error">{walkError}</p>}
      {importError && <p className={styles.error} role="alert" data-testid="import-error">{importError}</p>}
      {rec && (
        <p className={styles.snapshot} data-testid="snapshot-note">
          This model is a snapshot of the townhouse as exported on {fmtDate(rec.importedAt)}. After you change walls, floors, windows, stairs or furniture in FloorGen,
          export it again and use Replace.
        </p>
      )}
      {notes.map((n) => <p key={n} className={styles.note} role="status" data-testid="viewer-note">{n}</p>)}
      <div className={styles.stage}>
        <div ref={host} className={styles.host} data-testid="viewer3d-canvas" tabIndex={nav === 'walk' ? 0 : -1}
          aria-label={nav === 'walk' ? 'Walk view. Use W A S D to move and the arrow keys to turn.' : undefined} />
        {nav === 'walk' && phase !== 'off' && <span className={styles.crosshair} aria-hidden />}
        {overlay && (
          <div className={styles.overlay} data-testid="viewer-overlay" role={webglError || planError || status === 'error' ? 'alert' : 'status'}>
            <strong>{overlay.title}</strong>
            {overlay.text && <span>{overlay.text}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
