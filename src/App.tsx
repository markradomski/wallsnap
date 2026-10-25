import { useEffect, useMemo, useRef, useState } from 'react'
import styles from './App.module.css'
import { ApiError, getFloors, getStatus, getWall, putArtwork } from './api'
import { Elevation } from './Elevation'
import { clampToWall, round1, validate } from './geometry'
import type { Artwork, FloorSummary, WallState } from './types'

const DEFAULT_ART: Artwork = { width: 60, height: 45, u: 0, v: 120 }
const FIELDS: { key: keyof Artwork; label: string }[] = [
  { key: 'width', label: 'Width (cm)' },
  { key: 'height', label: 'Height (cm)' },
  { key: 'u', label: 'u: centre from endpoint A (cm)' },
  { key: 'v', label: 'v: bottom above floor (cm)' },
]

type Msg = { kind: 'ok' | 'error' | 'info'; text: string }

export function App() {
  const [adapter, setAdapter] = useState<string>('')
  const [floors, setFloors] = useState<FloorSummary[]>([])
  const [floorId, setFloorId] = useState('')
  const [wallId, setWallId] = useState('')
  const [state, setState] = useState<WallState | null>(null)
  const [art, setArt] = useState<Artwork | null>(null)
  const [text, setText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>('Loading project…')
  const [msg, setMsg] = useState<Msg | null>(null)
  const [stale, setStale] = useState(false)
  const typing = useRef(false)

  const fail = (e: unknown) => {
    setMsg({ kind: 'error', text: (e as Error).message })
    if (e instanceof ApiError && e.status === 409) setStale(true)
  }

  useEffect(() => {
    Promise.all([getStatus(), getFloors()])
      .then(([s, f]) => {
        setAdapter(s.adapter)
        setFloors(f)
        const first = f.find((x) => x.walls.some((w) => !w.reserved))
        if (first) setFloorId(first.id)
      })
      .catch(fail)
      .finally(() => setBusy(null))
  }, [])

  const floor = floors.find((f) => f.id === floorId)
  const wallInfo = floor?.walls.find((w) => w.id === wallId)

  const load = (fId: string, wId: string) => {
    if (!fId || !wId) return
    setBusy('Loading wall…')
    setMsg(null)
    setStale(false)
    getWall(fId, wId)
      .then((s) => {
        setState(s)
        setArt(s.artwork ?? clampToWall(s.wall, { ...DEFAULT_ART, u: s.wall.length / 2 }))
        if (s.artwork) setMsg({ kind: 'info', text: 'Loaded the existing artwork from FloorGen.' })
      })
      .catch((e) => {
        setState(null)
        setArt(null)
        fail(e)
      })
      .finally(() => setBusy(null))
  }

  // Keep the numeric inputs in sync with the model (drag, nudge, load).
  useEffect(() => {
    if (typing.current) typing.current = false
    else if (art) setText(Object.fromEntries(FIELDS.map((f) => [f.key, String(round1(art[f.key]))])))
  }, [art])

  const typed = (key: keyof Artwork, value: string) => {
    setText((t) => ({ ...t, [key]: value }))
    const n = Number(value)
    if (value.trim() !== '' && Number.isFinite(n) && art) {
      typing.current = true
      setArt({ ...art, [key]: n })
    }
  }
  const parsed = useMemo(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, text[f.key] === undefined || text[f.key].trim() === '' ? NaN : Number(text[f.key])])) as unknown as Artwork,
    [text],
  )
  const problems = state && art ? validate(state.wall, parsed) : []
  const invalid = problems.length > 0

  const apply = () => {
    if (!state || invalid) return
    setBusy('Applying to FloorGen…')
    setMsg(null)
    putArtwork(state.wall.floorId, state.wall.id, parsed, state.rev)
      .then((r) => {
        setState({ ...state, rev: r.rev, artwork: r.artwork })
        setArt(r.artwork)
        setMsg({ kind: 'ok', text: `Verified in FloorGen: ${r.created ? 'created' : 'updated'} artwork ${r.artwork.width}×${r.artwork.height} cm, u ${round1(r.artwork.u)} cm, v ${round1(r.artwork.v)} cm.` })
      })
      .catch(fail)
      .finally(() => setBusy(null))
  }

  return (
    <main className={styles.page}>
      <header>
        <h1>WallSnap</h1>
        {adapter === 'mock' && <p className={styles.mock}>MOCK ADAPTER: in-memory data, not connected to FloorGen.</p>}
      </header>

      <section className={styles.pickers}>
        <label>
          Floor
          <select value={floorId} onChange={(e) => { setFloorId(e.target.value); setWallId(''); setState(null); setArt(null) }}>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label>
          Wall
          <select value={wallId} onChange={(e) => { setWallId(e.target.value); load(floorId, e.target.value) }}>
            <option value="" disabled>Select a wall…</option>
            {floor?.walls.map((w) => (
              <option key={w.id} value={w.id} disabled={w.reserved}>
                {w.label}{w.reserved ? ' (reserved)' : ''}
              </option>
            ))}
          </select>
        </label>
        {state && <output className={styles.dims}>Wall: {round1(state.wall.length)} × {round1(state.wall.height)} cm</output>}
      </section>

      {busy && <p role="status" className={styles.busy}>{busy}</p>}
      {msg && <p role="alert" className={styles[msg.kind]}>{msg.text}</p>}
      {stale && wallInfo && <button onClick={() => load(floorId, wallId)}>Reload from FloorGen</button>}

      {state && art && (
        <div className={styles.editor}>
          <Elevation wall={state.wall} artwork={art} onChange={setArt} />
          <form className={styles.controls} onSubmit={(e) => { e.preventDefault(); apply() }}>
            {FIELDS.map((f) => {
              const bad = !Number.isFinite(parsed[f.key])
              return (
                <label key={f.key}>
                  {f.label}
                  <input
                    inputMode="decimal"
                    value={text[f.key] ?? ''}
                    aria-invalid={bad}
                    onChange={(e) => typed(f.key, e.target.value)}
                  />
                </label>
              )
            })}
            {invalid && <ul className={styles.problems}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
            <button type="submit" disabled={invalid || !!busy}>Apply to FloorGen</button>
          </form>
        </div>
      )}
    </main>
  )
}
