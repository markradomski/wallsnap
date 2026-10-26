import styles from './Inspector.module.css'
import { SAVE_GLYPH, SAVE_LABEL, type SaveState } from './saveState'
import { ALLOWED_TYPES, TYPE_LABEL } from './image'
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

export interface ArtworkEntry {
  key: string
  label: string
  thumb: string | null
  status: 'new' | 'unsaved' | 'saved' | 'detached'
}
const STATUS_LABEL: Record<ArtworkEntry['status'], string> = { new: 'Not saved yet', unsaved: 'Unsaved changes', saved: 'Saved', detached: 'Not on this wall' }

interface Props {
  artworks: ArtworkEntry[]
  selectedKey: string | null
  onSelect: (key: string) => void
  onAdd: () => void
  onDelete: () => void
  confirmDelete: boolean
  onConfirmDelete: () => void
  onCancelDelete: () => void
  deleting: boolean
  canDelete: boolean
  canAdd: boolean
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
  /** The local artwork image (never sent to FloorGen). */
  image: { url: string; name: string; width: number; height: number } | null
  imageNote: string | null
  imageBusy: boolean
  onPickImage: (file: File) => void
  lockRatio: boolean
  onLockRatio: (v: boolean) => void
  /** True when the frame is a different shape from the image, so the image is shown fitted with the frame showing. */
  ratioMismatch: boolean
  onMatchRatio: () => void
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

      {p.confirmDelete && (
        // Deleting removes the item from FloorGen (to its trash). "Keep" is the safe default.
        <div className={styles.confirm} role="alertdialog" aria-labelledby="delete-confirm-title" data-testid="delete-confirm" onKeyDown={(e) => e.key === 'Escape' && p.onCancelDelete()}>
          <strong id="delete-confirm-title">Delete this artwork from FloorGen?</strong>
          <p>Only the selected artwork is removed (FloorGen keeps it in its trash). The others on this wall are not touched.</p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.reload} autoFocus onClick={p.onCancelDelete}>Keep it</button>
            <button type="button" className={styles.danger} onClick={p.onConfirmDelete}>Delete artwork</button>
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

      <fieldset className={styles.list} data-testid="artwork-list">
        <legend>Artworks on this wall</legend>
        <ul>
          {p.artworks.map((a, i) => (
            <li key={a.key}>
              <button
                type="button"
                className={styles.entry}
                aria-pressed={a.key === p.selectedKey}
                data-testid="artwork-entry"
                data-status={a.status}
                onClick={() => p.onSelect(a.key)}
              >
                {a.thumb ? <img className={styles.entryThumb} src={a.thumb} alt="" /> : <span className={styles.entryThumbEmpty} aria-hidden="true" />}
                <span className={styles.entryText}>
                  <span className={styles.entryName} title={a.label}>{a.label}{p.artworks.length > 1 ? ` (${i + 1})` : ''}</span>
                  <span className={styles.entryState}>{STATUS_LABEL[a.status]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.listActions}>
          <button type="button" className={styles.secondary} onClick={p.onAdd} disabled={!p.canAdd} data-testid="add-artwork">+ Add artwork</button>
          <button type="button" className={styles.dangerLink} onClick={p.onDelete} disabled={!p.canDelete} aria-busy={p.deleting} data-testid="delete-artwork">
            {p.deleting ? 'Deleting…' : 'Delete selected artwork'}
          </button>
        </div>
      </fieldset>

      <fieldset className={styles.imageBox}>
        <legend>Artwork image</legend>
        <div className={styles.imageRow}>
          {p.image ? (
            <img className={styles.thumb} src={p.image.url} alt="Artwork thumbnail" data-testid="thumbnail" />
          ) : (
            <span className={styles.thumbEmpty} aria-hidden="true" />
          )}
          <div className={styles.imageMeta} data-testid="image-meta">
            {p.image ? (
              <>
                <span className={styles.fileName} title={p.image.name}>{p.image.name}</span>
                <span>{p.image.width} × {p.image.height} px · ratio {(p.image.width / p.image.height).toFixed(2)}</span>
              </>
            ) : (
              <span>No image. The artwork is a plain rectangle.</span>
            )}
          </div>
        </div>
        <div className={styles.imageActions}>
          <label className={styles.filePick} aria-disabled={p.imageBusy}>
            <input
              type="file"
              className={styles.srOnly}
              accept={ALLOWED_TYPES.join(',')}
              aria-label="Artwork image file"
              disabled={p.imageBusy}
              data-testid="image-input"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = '' // so choosing the same file again still fires
                if (f) p.onPickImage(f)
              }}
            />
            <span>{p.imageBusy ? 'Checking image…' : p.image ? 'Replace image…' : 'Choose image…'}</span>
          </label>
          {p.image && (
            <label className={styles.check}>
              <input type="checkbox" checked={p.lockRatio} onChange={(e) => p.onLockRatio(e.target.checked)} />
              Lock proportions
            </label>
          )}
        </div>
        {p.imageNote && <p className={styles.imageNote} role="alert" data-testid="image-note">{p.imageNote}</p>}
        {p.image && p.ratioMismatch && (
          <p className={styles.help} data-testid="ratio-note">
            The frame is a different shape from the image, so the image is shown whole inside it (not cropped or stretched).{' '}
            <button type="button" className={styles.linkish} onClick={p.onMatchRatio}>Match image proportions</button>
          </p>
        )}
        <p className={styles.help} data-testid="image-storage-note">
          {TYPE_LABEL}, up to 15 MB. Stored in this browser only: FloorGen receives the artwork's size and position, and custom
          images are not shown in FloorGen 3D.
        </p>
      </fieldset>

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
