/**
 * Walk mode's browser side: first-person camera, keyboard, mouse look and pointer lock around the pure movement code in
 * walkMove.ts. It only moves the camera. Listeners exist only while Walk mode is on and the animation loop runs only while a
 * key is held, so switching modes repeatedly leaves nothing behind.
 */
import type * as THREE from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { WalkData } from '../types'
import { CM } from './transform'
import { buildColliders, EYE_CM, isFree, RADIUS_CM, type Obb, type V2 } from './walkGeometry'
import {
  anyKey, applyLook, findStart, NO_KEYS, stepWalk, walkPhase, type Keys, type StartResult, type WalkEvent, type WalkPhase, type WalkState,
} from './walkMove'

export const WALK_FOV = 70

export interface WalkTarget {
  /** The artwork's centre in plan cm (the previewed one, so unsaved edits are what you walk up to), and its room-facing normal. */
  artwork: V2
  normal: V2
}

interface Options {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  /** The canvas: clicking it captures the pointer. */
  canvas: HTMLElement
  /** The focusable element around the canvas: keys work while it has focus, or while the pointer is captured. */
  focusEl: HTMLElement
  invalidate: () => void
  onPhase: (p: WalkPhase) => void
  /** The browser refused to capture the mouse (some embedded or headless browsers do): keyboard walking and turning still work. */
  onLockRefused?: () => void
}

const KEY_MAP: Record<string, keyof Keys> = {
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right',
  ArrowLeft: 'turnLeft', ArrowRight: 'turnRight', ShiftLeft: 'fast', ShiftRight: 'fast',
}

export class WalkRig {
  phase: WalkPhase = 'off'
  private state: WalkState | null = null
  private colliders: Obb[] = []
  private walls: { a: V2; b: V2 }[] = []
  private data: WalkData | null = null
  private keys: Keys = { ...NO_KEYS }
  private raf = 0
  private last = 0
  private listeners = 0
  private startedFor = ''
  private orbit: { position: THREE.Vector3; target: THREE.Vector3; fov: number; near: number } | null = null
  start: StartResult | null = null

  constructor(private o: Options) {}

  private on<K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void, capture?: boolean): () => void
  private on<K extends keyof DocumentEventMap>(t: Document, type: K, fn: (e: DocumentEventMap[K]) => void): () => void
  private on(t: EventTarget, type: string, fn: (e: never) => void, capture = false): () => void {
    t.addEventListener(type, fn as EventListener, capture)
    this.listeners++
    return () => {
      t.removeEventListener(type, fn as EventListener, capture)
      this.listeners--
    }
  }
  private off: (() => void)[] = []

  private dispatch(ev: WalkEvent) {
    const next = walkPhase(this.phase, ev)
    if (next === this.phase) return
    this.phase = next
    if (next !== 'locked') this.keys = { ...NO_KEYS }
    this.o.onPhase(next)
  }

  /** Start Walk mode. The orbit camera is remembered and comes back on exit. */
  enter() {
    if (this.phase !== 'off') return
    const { camera, controls } = this.o
    this.orbit = { position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, near: camera.near }
    controls.enabled = false
    camera.fov = WALK_FOV
    camera.near = 0.05
    camera.updateProjectionMatrix()
    const doc = this.o.canvas.ownerDocument
    this.off.push(
      this.on(window, 'keydown', (e) => this.key(e, true), true),
      this.on(window, 'keyup', (e) => this.key(e, false), true),
      this.on(window, 'blur', () => (this.keys = { ...NO_KEYS })),
      this.on(doc, 'mousemove', (e) => this.look(e)),
      this.on(doc, 'pointerlockchange', () => this.dispatch(doc.pointerLockElement === this.o.canvas ? 'lock' : 'unlock')),
    )
    const click = () => this.capture()
    this.o.canvas.addEventListener('click', click)
    this.listeners++
    this.off.push(() => {
      this.o.canvas.removeEventListener('click', click)
      this.listeners--
    })
    this.dispatch('enter')
    this.startedFor = ''
    this.place()
  }

  /** Leave Walk mode: release the pointer, stop the loop, remove every listener, bring back the orbit camera. */
  exit() {
    if (this.phase === 'off') return
    const doc = this.o.canvas.ownerDocument
    if (doc.pointerLockElement === this.o.canvas) doc.exitPointerLock()
    this.stop()
    this.off.splice(0).forEach((f) => f())
    this.keys = { ...NO_KEYS }
    this.dispatch('exit')
    const { camera, controls } = this.o
    if (this.orbit) {
      camera.position.copy(this.orbit.position)
      controls.target.copy(this.orbit.target)
      camera.fov = this.orbit.fov
      camera.near = this.orbit.near
      camera.updateProjectionMatrix()
    }
    controls.enabled = true
    controls.update()
    this.o.invalidate()
  }

  dispose() {
    this.exit()
  }

  /**
   * Give Walk mode the storey's collision data and what to look at. The start position is (re)computed when the floor or
   * wall changes, and when Walk mode is first entered; otherwise the walker stays where they are.
   */
  setData(data: WalkData | null, target: WalkTarget | null, key: string) {
    this.data = data
    this.colliders = data ? buildColliders(data) : []
    this.walls = data ? data.walls.map((w) => ({ a: w.a, b: w.b })) : []
    this.target = target
    if (key !== this.startedFor || !this.state) {
      this.startedFor = key
      this.place()
    }
  }
  private target: WalkTarget | null = null

  private place() {
    this.stop()
    this.state = null
    this.start = null
    if (this.phase === 'off' || !this.data || !this.target) return
    this.start = findStart({ artwork: this.target.artwork, normal: this.target.normal, colliders: this.colliders, walls: this.walls })
    if (this.start.ok) {
      this.state = this.start.state
      this.apply()
    }
    this.o.onPhase(this.phase) // let the UI re-read the start result
  }

  /** Camera from the walk state: eye height above the floor's base, looking along heading and pitch. */
  private apply() {
    const s = this.state
    const d = this.data
    if (!s || !d) return
    const { camera } = this.o
    const eye = (d.baseCm + EYE_CM) * CM
    camera.position.set(s.x * CM, eye, s.y * CM)
    const cp = Math.cos(s.pitch)
    camera.lookAt(camera.position.x + Math.cos(s.heading) * cp, eye + Math.sin(s.pitch), camera.position.z + Math.sin(s.heading) * cp)
    this.o.invalidate()
  }

  private capture() {
    if (this.phase === 'off' || !this.state) return
    try {
      const p = this.o.canvas.requestPointerLock() as unknown
      if (p instanceof Promise) p.catch(() => this.o.onLockRefused?.())
    } catch {
      this.o.onLockRefused?.()
    }
    this.o.focusEl.focus()
  }

  private active() {
    return this.phase === 'locked' || this.o.focusEl.contains(this.o.canvas.ownerDocument.activeElement)
  }

  private key(e: KeyboardEvent, down: boolean) {
    const k = KEY_MAP[e.code]
    if (!k || this.phase === 'off') return
    if (down && !this.active()) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    if (this.keys[k] === down) return
    this.keys = { ...this.keys, [k]: down }
    if (down) this.run()
  }

  private look(e: MouseEvent) {
    if (this.phase !== 'locked' || !this.state) return
    this.state = applyLook(this.state, e.movementX, e.movementY)
    this.apply()
  }

  private run() {
    if (this.raf || !this.state) return
    this.last = performance.now()
    const tick = (now: number) => {
      this.raf = 0
      if (this.phase === 'off' || !this.state) return
      this.state = stepWalk(this.state, this.keys, (now - this.last) / 1000, this.colliders)
      this.last = now
      this.apply()
      if (anyKey(this.keys)) this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** Diagnostics and tests: put the walker at a free spot (refused if it is inside a collider). Only the camera moves. */
  debugPlace(x: number, y: number, headingDeg: number): boolean {
    if (!this.state || !isFree({ x, y }, this.colliders, RADIUS_CM)) return false
    this.state = { ...this.state, x, y, heading: (headingDeg * Math.PI) / 180, pitch: 0 }
    this.apply()
    return true
  }

  debugState() {
    const s = this.state
    return {
      phase: this.phase,
      x: s ? +s.x.toFixed(3) : null,
      y: s ? +s.y.toFixed(3) : null,
      headingDeg: s ? +((s.heading * 180) / Math.PI).toFixed(3) : null,
      pitchDeg: s ? +((s.pitch * 180) / Math.PI).toFixed(3) : null,
      eyeCm: this.data ? this.data.baseCm + EYE_CM : null,
      loopRunning: this.raf !== 0,
      listeners: this.listeners,
      colliders: this.colliders.length,
      start: this.start && (this.start.ok ? { ok: true as const, distanceCm: +this.start.distanceCm.toFixed(1) } : { ok: false as const, reason: this.start.reason }),
    }
  }
}
