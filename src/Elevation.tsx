import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { clampToWall, nudge } from './geometry'
import styles from './Elevation.module.css'
import type { Artwork, WallView } from './types'

interface Props {
  wall: WallView
  artwork: Artwork
  onChange: (a: Artwork) => void
}

const MARGIN = 20

/** Wall elevation in a cm-based SVG viewBox: coordinates never depend on screen size. Endpoint A is always at the left (x = u), y is flipped so 0 = floor. */
export function Elevation({ wall, artwork: a, onChange }: Props) {
  const svg = useRef<SVGSVGElement>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)

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
      <rect className={styles.wall} x={0} y={0} width={wall.length} height={wall.height} />
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
        className={styles.art}
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
      />
    </svg>
  )
}
