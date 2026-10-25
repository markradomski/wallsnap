import styles from './TopBar.module.css'
import { SAVE_GLYPH, SAVE_LABEL, type SaveState } from './saveState'
import type { ThemePref } from './theme'
import type { FloorSummary } from './types'

interface Props {
  floors: FloorSummary[]
  floorId: string
  wallId: string
  onFloor: (id: string) => void
  onWall: (id: string) => void
  save: SaveState
  theme: ThemePref
  onTheme: (t: ThemePref) => void
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

/** Compact application bar: identity, wall picker, save status, theme. */
export function TopBar({ floors, floorId, wallId, onFloor, onWall, save, theme, onTheme }: Props) {
  const floor = floors.find((f) => f.id === floorId)
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <h1>WallSnap</h1>
      </div>

      <div className={styles.pickers}>
        <label>
          <span>Floor</span>
          <select value={floorId} onChange={(e) => onFloor(e.target.value)}>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label>
          <span>Wall</span>
          <select value={wallId} onChange={(e) => onWall(e.target.value)}>
            <option value="" disabled>Select a wall…</option>
            {floor?.walls.map((w) => (
              <option key={w.id} value={w.id} disabled={w.reserved}>
                {w.label}{w.reserved ? ' (reserved)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.right}>
        <span className={`${styles.status} ${styles[save]}`} data-testid="save-status" data-state={save}>
          <span aria-hidden="true">{SAVE_GLYPH[save]}</span> {SAVE_LABEL[save]}
        </span>
        <div className={styles.theme} role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => onTheme(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
