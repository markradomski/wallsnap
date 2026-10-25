import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampToWall, dimensionLabelPlacement, handlePoint, nudge, resizeFromHandle, round1, type Handle } from './geometry'
import styles from './Elevation.module.css'
import type { Artwork, WallView } from './types'

interface Props {
  wall: WallView
  /** Null while the saved artwork is not on this wall: only the wall is drawn. */
  artwork: Artwork | null
  /** Object URL of the local artwork image, drawn fitted inside the frame (never cropped or stretched). */
  image?: string | null
  /** Resize handles keep the frame's current width ÷ height. */
  lockRatio?: boolean
  onImageError?: () => void
  onChange: (a: Artwork) => void
}

const PLACEHOLDER: Artwork = { width: 1, height: 1, u: 0, v: 0 }

const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] // corners last so they win where hit areas overlap
const CURSOR: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}
/** Sizes in screen pixels; converted to wall cm through the SVG's own transform so they stay constant on screen. */
const HANDLE_PX = 8
const HIT_PX = 26
const MIN_HIT_PX = 12
const FONT_PX = 12
const LABEL_H_PX = 20
const LABEL_CHAR_PX = 6.9 // tabular digits at FONT_PX; the pill adds padding so small estimate errors never clip

/**
 * Wall elevation. The viewBox is exactly the wall in cm (x = u from endpoint A, y flipped so 0 = floor), so geometry
 * never depends on screen size; the browser's meet-scaling keeps proportions and getScreenCTM maps pointers back.
 */
export function Elevation({ wall, artwork, image = null, lockRatio = false, onImageError, onChange }: Props) {
  const a = artwork ?? PLACEHOLDER // never drawn when null; keeps the hooks and handlers below unconditional
  const svg = useRef<SVGSVGElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  const resizing = useRef<{ handle: Handle; du: number; dv: number } | null>(null)
  const [activeHandle, setActiveHandle] = useState<Handle | null>(null)
  const [selected, setSelected] = useState(true)
  const [pxPerCm, setPxPerCm] = useState(1)

  useEffect(() => setSelected(true), [wall.id])
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const update = () => setPxPerCm(el.getScreenCTM()?.a || 1)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [wall.length, wall.height])

  /** Pointer -> wall cm (u from endpoint A, v above floor), via the SVG transform, never raw CSS pixels. */
  const toWall = (e: PointerEvent) => {
    const m = svg.current!.getScreenCTM()!.inverse()
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
    return { x: p.x, y: wall.height - p.y }
  }

  const down = (e: PointerEvent<SVGRectElement>) => {
    const p = toWall(e)
    grab.current = { dx: p.x - a.u, dy: p.y - (a.v + a.height / 2) }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    setSelected(true)
  }
  const move = (e: PointerEvent) => {
    if (!grab.current) return
    const p = toWall(e)
    onChange(clampToWall(wall, { ...a, u: p.x - grab.current.dx, v: p.y - grab.current.dy - a.height / 2 }))
  }
  const downHandle = (handle: Handle) => (e: PointerEvent<SVGRectElement>) => {
    e.stopPropagation()
    const p = toWall(e)
    const at = handlePoint(a, handle)
    resizing.current = { handle, du: p.x - at.u, dv: p.y - at.v } // keep the grab point under the cursor
    setActiveHandle(handle)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveHandle = (e: PointerEvent) => {
    const r = resizing.current
    if (!r) return
    const p = toWall(e)
    onChange(resizeFromHandle(wall, a, r.handle, { u: p.x - r.du, v: p.y - r.dv }, lockRatio))
  }
  const endResize = () => {
    resizing.current = null
    setActiveHandle(null)
  }
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    }
    if (!d[e.key]) return
    e.preventDefault()
    onChange(nudge(wall, a, ...d[e.key]))
  }

  const px = (n: number) => n / pxPerCm
  const top = wall.height - a.v - a.height
  const L = wall.length
  const H = wall.height
  const dimGap = px(16)
  // On a small on-screen artwork, shrink the hit areas so the middle third stays a move target, not a resize one.
  const hitPx = Math.max(MIN_HIT_PX, Math.min(HIT_PX, (Math.min(a.width, a.height) * pxPerCm) / 3))

  return (
    <svg
      ref={svg}
      className={styles.svg}
      viewBox={`0 0 ${L} ${H}`}
      role="img"
      aria-label={`Wall elevation ${round1(L)} by ${round1(H)} centimetres`}
      data-testid="elevation"
      style={{ ['--font' as string]: `${px(FONT_PX)}px` }}
    >
      <rect className={styles.wall} x={0} y={0} width={L} height={H} onPointerDown={() => setSelected(false)} />
      {wall.openings.map((o) => (
        <rect key={o.id} className={styles.opening} x={o.left} y={H - o.sill - o.height} width={o.width} height={o.height}>
          <title>{o.kind}</title>
        </rect>
      ))}
      <line className={styles.floor} x1={0} x2={L} y1={H} y2={H} />

      {/* Orientation and dimensions, sized in screen pixels. */}
      <text className={styles.end} x={0} y={-px(8)} textAnchor="start">A · 0</text>
      <text className={styles.endCentre} x={L / 2} y={-px(8)} textAnchor="middle">A → B</text>
      <text className={styles.end} x={L} y={-px(8)} textAnchor="end">B · {round1(L)}</text>
      <g className={styles.dim}>
        <line x1={0} x2={L} y1={H + dimGap} y2={H + dimGap} />
        <line x1={0} x2={0} y1={H + dimGap - px(4)} y2={H + dimGap + px(4)} />
        <line x1={L} x2={L} y1={H + dimGap - px(4)} y2={H + dimGap + px(4)} />
        <line x1={-dimGap} x2={-dimGap} y1={0} y2={H} />
        <line x1={-dimGap - px(4)} x2={-dimGap + px(4)} y1={0} y2={0} />
        <line x1={-dimGap - px(4)} x2={-dimGap + px(4)} y1={H} y2={H} />
        <text x={L / 2} y={H + dimGap + px(15)} textAnchor="middle">{round1(L)} cm</text>
        <text x={-dimGap - px(6)} y={H / 2} textAnchor="middle" transform={`rotate(-90 ${-dimGap - px(6)} ${H / 2})`}>{round1(H)} cm</text>
      </g>

      {artwork && image && (
        <>
          {/* The frame's own colour shows behind a fitted image if the frame and image proportions differ. */}
          <rect className={styles.artBack} x={a.u - a.width / 2} y={top} width={a.width} height={a.height} pointerEvents="none" />
          <image
            href={image}
            data-testid="artwork-image"
            x={a.u - a.width / 2}
            y={top}
            width={a.width}
            height={a.height}
            preserveAspectRatio="xMidYMid meet"
            pointerEvents="none"
            onError={onImageError}
          />
        </>
      )}
      {artwork && (
      <rect
        className={`${styles.art} ${image ? styles.withImage : ''} ${selected ? styles.selected : ''}`}
        data-testid="artwork"
        tabIndex={0}
        role="slider"
        aria-label="Artwork. Arrow keys move 1 cm, Shift plus arrow keys move 10 cm."
        aria-valuetext={`horizontal position ${a.u.toFixed(1)} cm from endpoint A, bottom elevation ${a.v.toFixed(1)} cm`}
        x={a.u - a.width / 2}
        y={top}
        width={a.width}
        height={a.height}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (grab.current = null)}
        onKeyDown={key}
        onFocus={() => setSelected(true)}
      />
      )}
      {artwork && selected && HANDLES.map((h) => {
        const at = handlePoint(a, h)
        const cx = at.u
        const cy = H - at.v
        const vis = px(HANDLE_PX)
        const hit = px(hitPx)
        return (
          <g key={h} className={`${styles.handleGroup} ${activeHandle === h ? styles.active : ''}`} data-testid={`handle-${h}`}>
            <rect className={styles.handle} x={cx - vis / 2} y={cy - vis / 2} width={vis} height={vis} pointerEvents="none" />
            <rect
              x={cx - hit / 2}
              y={cy - hit / 2}
              width={hit}
              height={hit}
              fill="transparent"
              style={{ cursor: CURSOR[h], touchAction: 'none' }}
              data-testid={`hit-${h}`}
              onPointerDown={downHandle(h)}
              onPointerMove={moveHandle}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          </g>
        )
      })}
      {artwork && selected && (() => {
        const text = `${round1(a.width)} × ${round1(a.height)} cm`
        const size = { w: text.length * LABEL_CHAR_PX + 16, h: LABEL_H_PX }
        const p = dimensionLabelPlacement(wall, a, pxPerCm, size, hitPx / 2 + 4)
        return (
          <g className={styles.label} data-testid="dimension-label" data-placement={p.placement} pointerEvents="none">
            <rect x={p.u - px(size.w) / 2} y={H - p.v - px(size.h) / 2} width={px(size.w)} height={px(size.h)} rx={px(4)} />
            <text x={p.u} y={H - p.v} textAnchor="middle" dominantBaseline="central">{text}</text>
          </g>
        )
      })()}
    </svg>
  )
}
