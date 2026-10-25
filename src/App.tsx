import { useEffect, useMemo, useState } from 'react'
import styles from './App.module.css'
import { ApiError, getFloors, getStatus, getWall, putArtwork } from './api'
import { Elevation } from './Elevation'
import { clampToWall, round1, validate } from './geometry'
import { Inspector, type FieldKey } from './Inspector'
import { deriveSaveState } from './saveState'
import { useTheme } from './theme'
import { TopBar } from './TopBar'
import type { Artwork, FloorSummary, WallState } from './types'

const DEFAULT_ART: Artwork = { width: 60, height: 45, u: 0, v: 120 }
const KEYS: FieldKey[] = ['width', 'height', 'u', 'v']

type Result = { kind: 'ok' | 'error'; text: string }

const format = (a: Artwork): Record<string, string> => Object.fromEntries(KEYS.map((k) => [k, String(round1(a[k]))]))

const describe = (a: Artwork) =>
  `${round1(a.width)}×${round1(a.height)} cm, horizontal position ${round1(a.u)} cm, bottom elevation ${round1(a.v)} cm`

export function App() {
  const [theme, setTheme] = useTheme()
  const [adapter, setAdapter] = useState('')
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [floorId, setFloorId] = useState('')
  const [wallId, setWallId] = useState('')
  const [state, setState] = useState<WallState | null>(null)
  const [art, setArt] = useState<Artwork | null>(null)
  const [text, setText] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [partial, setPartial] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)

  const fail = (e: unknown) => {
    const text = e instanceof Error ? e.message : 'Unexpected error'
    if (e instanceof ApiError && (e.status === 409 || e.code === 'stale')) setConflict(text)
    else if (e instanceof ApiError && e.code === 'partial') setPartial(text)
    else setResult({ kind: 'error', text })
  }

  useEffect(() => {
    Promise.all([getStatus(), getFloors()])
      .then(([s, f]) => {
        setAdapter(s.adapter)
        setViewerUrl(s.viewer3dUrl?.startsWith('https://floorgen.app/') ? s.viewer3dUrl : null)
        setFloors(f)
        const first = f.find((x) => x.walls.some((w) => !w.reserved))
        if (first) setFloorId(first.id)
      })
      .catch(fail)
      .finally(() => setLoading(false))
  }, [])

  const clearOutcome = () => {
    setResult(null)
    setConflict(null)
    setPartial(null)
    setVerified(false)
  }

  const load = (fId: string, wId: string) => {
    if (!fId || !wId) return
    setLoading(true)
    clearOutcome()
    getWall(fId, wId)
      .then((s) => {
        const initial = s.artwork ?? clampToWall(s.wall, { ...DEFAULT_ART, u: s.wall.length / 2 })
        setState(s)
        setArt(initial)
        setText(format(initial)) // same update as the artwork, so the inputs are never empty or stale
      })
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
  }
  const typed = (key: FieldKey, value: string) => {
    setText((t) => ({ ...t, [key]: value }))
    const n = Number(value)
    if (value.trim() !== '' && Number.isFinite(n) && art) edit({ ...art, [key]: n }, false) // keep what is being typed
  }
  const parsed = useMemo(
    () => Object.fromEntries(KEYS.map((k) => [k, text[k] === undefined || text[k].trim() === '' ? NaN : Number(text[k])])) as unknown as Artwork,
    [text],
  )
  const problems = state && art ? validate(state.wall, parsed) : []

  const apply = () => {
    if (!state || problems.length || saving || conflict || partial) return
    setSaving(true)
    clearOutcome()
    putArtwork(state.wall.floorId, state.wall.id, parsed, state.rev)
      .then((r) => {
        setState({ ...state, rev: r.rev, artwork: r.artwork })
        setArt(r.artwork)
        setText(format(r.artwork))
        setVerified(true)
        setResult({ kind: 'ok', text: `Verified in FloorGen: ${r.created ? 'created' : 'updated'} artwork ${describe(r.artwork)}. Re-read from FloorGen after saving (revision ${r.rev}).` })
      })
      .catch(fail)
      .finally(() => setSaving(false))
  }

  const save = deriveSaveState({
    hasWall: !!state, loading, saving, conflict: !!conflict, partial: !!partial, error: result?.kind === 'error',
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
      synced: 'This matches what FloorGen currently holds.',
      verified: '',
      conflict: '',
      partial: '',
      error: '',
      invalid: '',
    } as const)[save]

  const wallLabel = floors.find((f) => f.id === floorId)?.walls.find((w) => w.id === wallId)?.label ?? ''

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

  return (
    <div className={styles.app}>
      <TopBar floors={floors} floorId={floorId} wallId={wallId} onFloor={onFloor} onWall={onWall} save={save} theme={theme} onTheme={setTheme} />
      {adapter === 'mock' && <p className={styles.mock}>MOCK ADAPTER: in-memory data, not connected to FloorGen.</p>}

      <div className={styles.workspace}>
        <main className={styles.editor}>
          {state && art ? (
            <>
              <div className={styles.meta}>
                {wallLabel && <span className={styles.wallName} title={wallLabel} data-testid="wall-name">{wallLabel}</span>}
                <span data-testid="wall-dims">Wall: {round1(state.wall.length)} × {round1(state.wall.height)} cm</span>
                <span>Endpoint A is at the left</span>
              </div>
              <div className={styles.stage}>
                <div className={styles.canvas} style={{ ['--aspect' as string]: state.wall.length / state.wall.height }}>
                  <Elevation wall={state.wall} artwork={art} onChange={edit} />
                </div>
              </div>
            </>
          ) : (
            <p className={styles.empty}>{loading ? 'Loading…' : 'Select a floor and wall in the bar above to start placing artwork.'}</p>
          )}
        </main>

        {state && art && (
          <Inspector
            text={text}
            valid={Object.fromEntries(KEYS.map((k) => [k, Number.isFinite(parsed[k])])) as Record<FieldKey, boolean>}
            onType={typed}
            problems={problems}
            save={save}
            detail={detail}
            onReload={conflict || partial ? () => load(floorId, wallId) : null}
            canApply={!problems.length && !saving && !loading && !conflict && !partial}
            onApply={apply}
            viewerUrl={viewerUrl}
          />
        )}
      </div>
    </div>
  )
}
