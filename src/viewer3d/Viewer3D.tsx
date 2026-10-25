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
import { TownhouseScene, WebGLUnavailableError, type ModelReport } from './scene'
import type { Artwork, PlanContext } from '../types'
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
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

type ModelStatus = 'loading' | 'none' | 'ready' | 'error'

export default function Viewer3D({ project, plan, planError, art, imageUrl, unsaved }: Viewer3DProps) {
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

  // The renderer: created once per mount, fully disposed on unmount, so toggling 2D/3D never accumulates loops or listeners.
  useEffect(() => {
    if (!host.current) return
    try {
      const s = new TownhouseScene(host.current)
      scene.current = s
      ;(window as unknown as { __wallsnap3d?: () => unknown }).__wallsnap3d = () => s.debugState()
      setReady(true)
      return () => {
        delete (window as unknown as { __wallsnap3d?: unknown }).__wallsnap3d
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
      {importError && <p className={styles.error} role="alert" data-testid="import-error">{importError}</p>}
      {rec && (
        <p className={styles.snapshot} data-testid="snapshot-note">
          This model is a snapshot of the townhouse as exported on {fmtDate(rec.importedAt)}. After you change walls, floors, windows, stairs or furniture in FloorGen,
          export it again and use Replace.
        </p>
      )}
      {notes.map((n) => <p key={n} className={styles.note} role="status" data-testid="viewer-note">{n}</p>)}
      <div className={styles.stage}>
        <div ref={host} className={styles.host} data-testid="viewer3d-canvas" />
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
