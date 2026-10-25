import styles from './Inspector.module.css'
import { SAVE_GLYPH, SAVE_LABEL, type SaveState } from './saveState'
import type { Artwork } from './types'

export type FieldKey = keyof Artwork

const SIZE: { key: FieldKey; label: string }[] = [
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
]
const POSITION: { key: FieldKey; label: string }[] = [
  { key: 'u', label: 'Horizontal position' },
  { key: 'v', label: 'Bottom elevation' },
]

interface Props {
  text: Record<string, string>
  valid: Record<FieldKey, boolean>
  onType: (key: FieldKey, value: string) => void
  problems: string[]
  save: SaveState
  detail: string
  onReload: (() => void) | null
  canApply: boolean
  onApply: () => void
  viewerUrl: string | null
}

function Field({ f, text, valid, onType }: { f: { key: FieldKey; label: string } } & Pick<Props, 'text' | 'valid' | 'onType'>) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{f.label}</span>
      <span className={styles.inputWrap}>
        <input inputMode="decimal" value={text[f.key] ?? ''} aria-invalid={!valid[f.key]} onChange={(e) => onType(f.key, e.target.value)} />
        <span className={styles.unit} aria-hidden="true">cm</span>
      </span>
    </label>
  )
}

/** Right-hand properties inspector: size, position, save status, actions. */
export function Inspector(p: Props) {
  const isAlert = ['conflict', 'partial', 'error', 'invalid'].includes(p.save)
  return (
    <form className={styles.inspector} onSubmit={(e) => { e.preventDefault(); p.onApply() }}>
      <div className={`${styles.card} ${styles[p.save]}`} role={isAlert ? 'alert' : 'status'} data-testid="status-card">
        <strong><span aria-hidden="true">{SAVE_GLYPH[p.save]}</span> {SAVE_LABEL[p.save]}</strong>
        {p.save === 'invalid' ? (
          <ul>{p.problems.map((m) => <li key={m}>{m}</li>)}</ul>
        ) : (
          <p data-testid="message">{p.detail}</p>
        )}
        {p.onReload && <button type="button" className={styles.reload} onClick={p.onReload}>Reload from FloorGen</button>}
      </div>

      <fieldset>
        <legend>Size</legend>
        <div className={styles.grid}>{SIZE.map((f) => <Field key={f.key} f={f} {...p} />)}</div>
      </fieldset>

      <fieldset>
        <legend>Position</legend>
        <div className={styles.grid}>{POSITION.map((f) => <Field key={f.key} f={f} {...p} />)}</div>
        <p className={styles.help}>
          Horizontal position is measured from endpoint A (the left end, 0 cm) to the artwork's centre. Bottom elevation is the
          height of its lower edge above the floor.
        </p>
      </fieldset>

      <p className={styles.hint}>
        Select the artwork, then use <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> to nudge 1 cm, or hold <kbd>Shift</kbd> for 10 cm.
        Drag the handles to resize. Changes stay local until you apply them.
      </p>

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={!p.canApply}>Apply to FloorGen</button>
        {p.viewerUrl && (
          // A plain link: opens a new tab, so this editing session and unsaved changes stay untouched.
          <a className={styles.secondary} href={p.viewerUrl} target="_blank" rel="noopener noreferrer">
            Open in FloorGen 3D
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className={styles.srOnly}>(opens in a new tab)</span>
          </a>
        )}
      </div>
    </form>
  )
}
