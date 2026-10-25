import styles from './Inspector.module.css'
import { SAVE_GLYPH, SAVE_LABEL, type SaveState } from './saveState'
import type { Artwork, Detached } from './types'

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
  disabled: boolean
  valid: Record<FieldKey, boolean>
  onType: (key: FieldKey, value: string) => void
  problems: string[]
  save: SaveState
  detail: string
  detached: Detached | null
  onPlaceBack: () => void
  canApply: boolean
  onApply: () => void
  reloading: boolean
  canReload: boolean
  onReload: () => void
  confirmReload: boolean
  onDiscardAndReload: () => void
  onKeepEditing: () => void
  viewerUrl: string | null
}

function Field({ f, text, valid, onType, disabled }: { f: { key: FieldKey; label: string } } & Pick<Props, 'text' | 'valid' | 'onType' | 'disabled'>) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{f.label}</span>
      <span className={styles.inputWrap}>
        <input inputMode="decimal" disabled={disabled} value={text[f.key] ?? ''} aria-invalid={!valid[f.key]} onChange={(e) => onType(f.key, e.target.value)} />
        <span className={styles.unit} aria-hidden="true">cm</span>
      </span>
    </label>
  )
}

/** Right-hand properties inspector: size, position, save status, actions. */
export function Inspector(p: Props) {
  const prominent = ['conflict', 'partial', 'error', 'invalid', 'detached'].includes(p.save)
  return (
    <form className={styles.inspector} onSubmit={(e) => { e.preventDefault(); p.onApply() }}>
      {p.confirmReload && (
        // Reload would replace local edits, so it asks first. "Keep editing" is the default, safe choice.
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-labelledby="reload-confirm-title"
          data-testid="reload-confirm"
          onKeyDown={(e) => e.key === 'Escape' && p.onKeepEditing()}
        >
          <strong id="reload-confirm-title">Discard your unsaved edits?</strong>
          <p>Reloading replaces them with what FloorGen currently holds.</p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.reload} autoFocus onClick={p.onKeepEditing}>Keep editing</button>
            <button type="button" className={styles.danger} onClick={p.onDiscardAndReload}>Discard and reload</button>
          </div>
        </div>
      )}

      {prominent ? (
        // Failures stay prominent and actionable.
        <div className={[styles.card, styles[p.save]].filter(Boolean).join(' ')} role="alert" data-testid="status-card">
          <strong><span aria-hidden="true">{SAVE_GLYPH[p.save]}</span> {SAVE_LABEL[p.save]}</strong>
          {p.save === 'invalid' ? (
            <ul>{p.problems.map((m) => <li key={m}>{m}</li>)}</ul>
          ) : (
            <>
              <p data-testid="message">{p.detail}</p>
              {p.save === 'detached' && p.detached && (
                <>
                  <ul>{p.detached.reasons.map((m) => <li key={m}>{m}</li>)}</ul>
                  <p>
                    It is still in FloorGen as {p.detached.width} × {p.detached.height} cm. Put it back on this wall, set its
                    position, then Apply to move that same artwork.
                  </p>
                  <button type="button" className={styles.reload} onClick={p.onPlaceBack}>Place back on this wall</button>
                </>
              )}
              {(p.save === 'conflict' || p.save === 'partial') && <p>Use Reload from FloorGen below to see the current state.</p>}
            </>
          )}
        </div>
      ) : p.save === 'verified' ? (
        // The header already says "Saved · verified"; here is only a brief confirmation with the read-back on demand.
        <details className={styles.confirmation} data-testid="status-note">
          <summary><span aria-hidden="true">✓</span> Read back from FloorGen</summary>
          <p data-testid="message">{p.detail}</p>
        </details>
      ) : (
        <p className={[styles.note, styles[p.save]].filter(Boolean).join(' ')} role="status" data-testid="status-note">
          <span aria-hidden="true">{SAVE_GLYPH[p.save]}</span> <span data-testid="message">{p.detail}</span>
        </p>
      )}

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
        <button type="button" className={styles.secondary} onClick={p.onReload} disabled={!p.canReload} aria-busy={p.reloading}>
          <svg className={p.reloading ? styles.spin : undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97M13.5 2v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {p.reloading ? 'Reloading…' : 'Reload from FloorGen'}
        </button>
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
