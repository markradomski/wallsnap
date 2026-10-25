import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampToWall, handlePoint, nudge, resizeFromHandle, type Handle } from './geometry'
import styles from './Elevation.module.css'
import type { Artwork, WallView } from './types'

interface Props {
  wall: WallView
  artwork: Artwork
  onChange: (a: Artwork) => void
}

const MARGIN = 20
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] // corners last so they win where hit areas overlap
const CURSOR: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}
/** Handle sizes in screen pixels, converted to wall cm through the SVG scale so they stay constant on screen. */
const HANDLE_PX = 9
const HIT_PX = 28

/** Wall elevation in a cm-based SVG viewBox: coordinates never depend on screen size. Endpoint A is always at the left (x = u), y is flipped so 0 = floor. */
export function Elevation({ wall, artwork: a, onChange }: Props) {
  const svg = useRef<SVGSVGElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  const resizing = useRef<{ handle: Handle; du: number; dv: number } | null>(null)
  const [selected, setSelected] = useState(true)
  const [pxPerCm, setPxPerCm] = useState(1)

  useEffect(() => setSelected(true), [wall.id])
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const update = () => setPxPerCm(el.clientWidth / (wall.length + 2 * MARGIN) || 1)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [wall.length])

  /** Pointer -> wall cm (x from left edge, y above floor). */
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
  const downHandle = (handle: Handle) => (e: PointerEvent<SVGRectElement>) => {
    e.stopPropagation()
    const p = toWall(e)
    const at = handlePoint(a, handle)
    resizing.current = { handle, du: p.x - at.u, dv: p.y - at.v } // keep the grab point under the cursor
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const moveHandle = (e: PointerEvent) => {
    const r = resizing.current
    if (!r) return
    const p = toWall(e)
    onChange(resizeFromHandle(wall, a, r.handle, { u: p.x - r.du, v: p.y - r.dv }))
  }
  const move = (e: PointerEvent) => {
    if (!grab.current) return
    const p = toWall(e)
    onChange(clampToWall(wall, { ...a, u: p.x - grab.current.dx, v: p.y - grab.current.dy - a.height / 2 }))
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

  return (
    <svg
      ref={svg}
      className={styles.svg}
      viewBox={`${-MARGIN} ${-MARGIN} ${wall.length + 2 * MARGIN} ${wall.height + 2 * MARGIN}`}
      role="img"
      aria-label={`Wall elevation ${wall.length} by ${wall.height} centimetres`}
      data-testid="elevation"
    >
      <rect className={styles.wall} x={0} y={0} width={wall.length} height={wall.height} onPointerDown={() => setSelected(false)} />
      {wall.openings.map((o) => (
        <rect
          key={o.id}
          className={styles.opening}
          x={o.left}
          y={wall.height - o.sill - o.height}
          width={o.width}
          height={o.height}
        >
          <title>{o.kind}</title>
        </rect>
      ))}
      <text className={styles.end} x={0} y={-6} textAnchor="start">A (u = 0)</text>
      <text className={styles.end} x={wall.length} y={-6} textAnchor="end">B (u = {Math.round(wall.length * 10) / 10})</text>
      <line className={styles.floor} x1={-MARGIN} x2={wall.length + MARGIN} y1={wall.height} y2={wall.height} />
      <rect
        className={`${styles.art} ${selected ? styles.selected : ''}`}
        data-testid="artwork"
        tabIndex={0}
        role="slider"
        aria-label="Artwork. Arrow keys move 1 cm, Shift plus arrow keys move 10 cm."
        aria-valuetext={`u ${a.u.toFixed(1)} cm from endpoint A, v ${a.v.toFixed(1)} cm above floor`}
        x={a.u - a.width / 2}
        y={wall.height - a.v - a.height}
        width={a.width}
        height={a.height}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (grab.current = null)}
        onKeyDown={key}
        onFocus={() => setSelected(true)}
      />
      {selected && HANDLES.map((h) => {
        const at = handlePoint(a, h)
        const cx = at.u
        const cy = wall.height - at.v
        const vis = HANDLE_PX / pxPerCm
        const hit = HIT_PX / pxPerCm
        return (
          <g key={h} data-testid={`handle-${h}`}>
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
              onPointerUp={() => (resizing.current = null)}
              onPointerCancel={() => (resizing.current = null)}
            />
          </g>
        )
      })}
    </svg>
  )
}
