import { useEffect, useRef, useState } from 'react'
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

function ThemeChoices({ theme, onTheme, onPick }: Pick<Props, 'theme' | 'onTheme'> & { onPick?: () => void }) {
  return (
    <>
      {THEMES.map((t) => (
        <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => { onTheme(t.id); onPick?.() }}>
          {t.label}
        </button>
      ))}
    </>
  )
}

/** Narrow screens: the theme choice lives in a small settings menu instead of taking header space. */
function SettingsMenu({ theme, onTheme }: Pick<Props, 'theme' | 'onTheme'>) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={styles.settings} ref={root}>
      <button ref={trigger} type="button" className={styles.gear} aria-label="Settings" aria-expanded={open} aria-controls="settings-panel" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="4" r="1.8" fill="var(--chrome-bg)" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="5.5" cy="8" r="1.8" fill="var(--chrome-bg)" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="10.5" cy="12" r="1.8" fill="var(--chrome-bg)" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <div id="settings-panel" className={styles.panel} role="group" aria-label="Theme">
          <span className={styles.panelTitle}>Theme</span>
          <ThemeChoices theme={theme} onTheme={onTheme} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** Compact application bar: identity, save status, wall picker, theme. Wraps into two short rows on narrow screens. */
export function TopBar({ floors, floorId, wallId, onFloor, onWall, save, theme, onTheme }: Props) {
  const floor = floors.find((f) => f.id === floorId)
  const wall = floor?.walls.find((w) => w.id === wallId)
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <h1>WallSnap</h1>
      </div>

      <div className={styles.pickers}>
        <label>
          <span>Floor</span>
          <select value={floorId} title={floor?.name} onChange={(e) => onFloor(e.target.value)}>
            {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label>
          <span>Wall</span>
          <select value={wallId} title={wall?.label} onChange={(e) => onWall(e.target.value)}>
            <option value="" disabled>Select a wall…</option>
            {floor?.walls.map((w) => (
              <option key={w.id} value={w.id} disabled={w.reserved}>
                {w.label}{w.reserved ? ' (reserved)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <span className={`${styles.status} ${styles[save]}`} data-testid="save-status" data-state={save}>
        <span aria-hidden="true">{SAVE_GLYPH[save]}</span> <span className={styles.statusText}>{SAVE_LABEL[save]}</span>
      </span>

      <div className={styles.theme} role="group" aria-label="Theme">
        <ThemeChoices theme={theme} onTheme={onTheme} />
      </div>
      <SettingsMenu theme={theme} onTheme={onTheme} />
    </header>
  )
}
