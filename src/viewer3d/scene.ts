/**
 * The Three.js side of the 3D preview. Everything that imports Three.js lives here, so the 2D editor never downloads it
 * (this module is only reached through a dynamic import). It is the Spike3D renderer, made reusable: same loader, same
 * coordinate conversion, same lighting, shadows and finishes, plus cheap updates for unsaved edits.
 *
 * It only ever READS: a model file, an image, and numbers handed to it. Nothing here can write to FloorGen.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PlanContext } from '../types'
import { categoryOf, colourOfMaterialName, finishFor, orbitPosition, shadowBounds } from './look'
import { frameOf, savedPlanItem } from './plan'
import { matchAllArtworks, type MatchEntry, type MatchResult, type WallContext } from './matching'
import { clusterSolidTriangles, withoutTriangles, type Solid } from './solids'
import { CM, fitContain, placementFor, type PlanItem } from './transform'
import { WalkRig, type WalkTarget } from './walkRig'
import type { WalkPhase } from './walkMove'

export class WebGLUnavailableError extends Error {
  constructor() {
    super('3D preview needs WebGL, which is not available in this browser (or has been disabled).')
  }
}

// ---- Shared look (also used by the spike) ----

export function createRenderer(): THREE.WebGLRenderer {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  } catch {
    throw new WebGLUnavailableError()
  }
  if (!renderer.getContext()) throw new WebGLUnavailableError()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0) // transparent: the page's CSS backdrop shows through
  // Khronos PBR Neutral keeps authored base colours close to what FloorGen exported while rolling off highlights.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1
  renderer.shadowMap.enabled = true
  renderer.shadowMap.autoUpdate = false // the sun and the building are static: shadows are redrawn only when `TownhouseScene.dirtyShadows` says so, so moving the camera stays cheap
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  return renderer
}

/** Soft neutral fill from a built-in studio environment plus a faint sky/ground tint. Returns what must be disposed. */
export function addAmbient(scene: THREE.Scene, renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer)
  const target = pmrem.fromScene(new RoomEnvironment(), 0.04)
  pmrem.dispose()
  scene.environment = target.texture
  scene.environmentIntensity = 0.45
  scene.add(new THREE.HemisphereLight(0xdbe7ff, 0x8d8576, 0.3))
  return target
}

export interface LookReport {
  distinctMaterials: number
  /** Materials whose loaded colour differs from the hex in their exported name: must be 0. */
  colourMismatches: number
  meshesByCategory: Record<string, number>
}

/** Per-category finish on CLONED materials (colours are never touched) and shadow flags. */
export function applyFinishes(root: THREE.Object3D): LookReport {
  const categoryFor = (o: THREE.Object3D) => {
    for (let n: THREE.Object3D | null = o; n; n = n.parent) {
      const c = categoryOf(n.name)
      if (c) return c
    }
    return null
  }
  const names = new Set<string>()
  let colourMismatches = 0
  const meshesByCategory: Record<string, number> = {}
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const src = m.material as THREE.MeshStandardMaterial
    names.add(src.name)
    const named = colourOfMaterialName(src.name)
    if (named && `#${src.color.getHexString()}` !== named) colourMismatches++
    const cat = categoryFor(m)
    meshesByCategory[cat ?? 'other'] = (meshesByCategory[cat ?? 'other'] ?? 0) + 1
    const finish = finishFor(cat)
    const mat = src.clone() // shared materials differ by category: never edit them in place
    mat.roughness = finish.roughness
    mat.metalness = finish.metalness
    if (finish.depthBias) {
      mat.polygonOffset = true
      mat.polygonOffsetFactor = finish.depthBias.factor
      mat.polygonOffsetUnits = finish.depthBias.units
    }
    m.material = mat
    m.castShadow = finish.castShadow
    m.receiveShadow = finish.receiveShadow
  })
  return { distinctMaterials: names.size, colourMismatches, meshesByCategory }
}

/** Aim one warm daylight at the building from the room's open side, with a shadow frustum fitted to the building. */
export function aimSun(sun: THREE.DirectionalLight, building: THREE.Box3, faceX: number, faceZ: number) {
  const c = building.getCenter(new THREE.Vector3())
  sun.position.set(...orbitPosition([c.x, c.y, c.z], { x: faceX, z: faceZ }, -32, 52, 30))
  sun.target.position.copy(c)
  Object.assign(sun.shadow.camera, shadowBounds(building.min.toArray(), building.max.toArray(), sun.position.toArray(), c.toArray(), 0.4))
  sun.shadow.camera.updateProjectionMatrix()
  sun.shadow.mapSize.set(4096, 4096)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.03
  sun.shadow.radius = 4
  sun.castShadow = true
}

// ---- The scene ----

export interface ModelReport extends LookReport {
  groupNames: string[]
  triangles: number
  /** Whole-building bounds in metres. */
  bounds: { min: [number, number, number]; max: [number, number, number] }
}

interface GenericMesh {
  mesh: THREE.Mesh
  solids: Solid[]
  /** The mesh's material colour (#rrggbb), so each artwork is only matched against stand-ins of its own colour. */
  colour: string
  original: THREE.BufferGeometry | null
}

/** A saved artwork other than the one being edited: drawn at its saved place, with its own image if one is stored locally. */
export interface OtherArtwork {
  id: string
  item: PlanItem
  /** The saved item to look for in the model when `item` is an unsaved edit of it (defaults to `item`). */
  matchItem?: PlanItem
  baseCm: number
  color: string
  /** The wall it hangs on, for matching its stand-in in the model; null when it is not flush on any wall. */
  wall: PlanContext['wall'] | null
  image: HTMLImageElement | null
  /** Index of its floor's group in the model, so it follows that floor's visibility (null: always shown). */
  groupIndex: number | null
}
interface OtherMesh {
  backing: THREE.Mesh
  image: THREE.Mesh
  texture: THREE.Texture | null
  source: HTMLImageElement | null
  data: OtherArtwork
}

const GENERIC_DEFAULT = '#4b5a70'

export class TownhouseScene {
  readonly renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100)
  private controls: OrbitControls
  private sun = new THREE.DirectionalLight(0xfff1de, 2.3)
  private env: THREE.WebGLRenderTarget
  private ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.22 }))
  private planeGeo = new THREE.PlaneGeometry(1, 1)
  private image = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({ toneMapped: false })) // unlit: true colours
  private backing = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({ toneMapped: false }))
  private texture: THREE.Texture | null = null
  private textureSource: HTMLImageElement | null = null
  private model: THREE.Group | null = null
  private groups: THREE.Object3D[] = []
  private generic: GenericMesh[] = []
  private genericColour = ''
  private others = new Map<string, OtherMesh>()
  matches = new Map<string, MatchResult>()
  private plan: PlanContext | null = null
  private framedFor = ''
  private modelId = 0
  private raf = 0
  private disposed = false
  private observer: ResizeObserver
  private onChange = () => this.invalidate()
  renderCount = 0
  private shadowsDirty = true
  readonly walk: WalkRig
  match: MatchResult = { status: 'unsaved', candidates: 0 }
  report: ModelReport | null = null

  constructor(private host: HTMLElement, onWalkPhase: (p: WalkPhase) => void = () => undefined, onLockRefused?: () => void) {
    this.renderer = createRenderer()
    host.appendChild(this.renderer.domElement)
    this.env = addAmbient(this.scene, this.renderer)
    this.scene.add(this.sun, this.sun.target)
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.ground.name = 'ground-shadow'
    this.ground.visible = false
    this.scene.add(this.ground)
    for (const m of [this.backing, this.image]) {
      m.visible = false
      this.scene.add(m)
    }
    this.image.name = 'wallsnap-artwork'
    this.backing.name = 'wallsnap-artwork-frame'
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', this.onChange)
    this.walk = new WalkRig({
      camera: this.camera, controls: this.controls, canvas: this.renderer.domElement, focusEl: host, invalidate: () => this.invalidate(), onPhase: onWalkPhase, onLockRefused,
    })
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth)
    const h = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.invalidate()
  }

  invalidate() {
    if (this.disposed || this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      if (this.disposed) return
      this.renderCount++
      if (this.shadowsDirty) {
        this.shadowsDirty = false
        this.renderer.shadowMap.needsUpdate = true
      }
      this.renderer.render(this.scene, this.camera)
    })
  }

  /**
   * Parse a GLB and, only if that works, swap it in (the previous model stays if parsing fails). Resources of the model
   * being replaced are disposed. Artwork transforms, images and the current wall are kept by the caller re-sending them.
   */
  async loadModel(buffer: ArrayBuffer): Promise<ModelReport> {
    const gltf = await new GLTFLoader().parseAsync(buffer, '')
    if (this.disposed) {
      disposeObject(gltf.scene)
      throw new Error('disposed')
    }
    this.disposeModel()
    this.shadowsDirty = true
    this.modelId++
    this.model = gltf.scene
    this.scene.add(gltf.scene)
    const look = applyFinishes(gltf.scene)
    this.groups = gltf.scene.children.slice()
    const building = new THREE.Box3().setFromObject(gltf.scene)
    const centre = building.getCenter(new THREE.Vector3())
    this.ground.position.set(centre.x, building.min.y - 0.004, centre.z)
    this.ground.visible = true
    let triangles = 0
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) triangles += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3
    })
    this.report = { ...look, groupNames: this.groups.map((g) => g.name), triangles, bounds: { min: building.min.toArray(), max: building.max.toArray() } }
    this.genericColour = ''
    this.framedFor = ''
    this.aimLight()
    this.refresh()
    return this.report
  }

  private aimLight() {
    this.shadowsDirty = true
    if (!this.model) return
    const n = this.plan?.wall.normal ?? { x: 0, y: 1 }
    aimSun(this.sun, new THREE.Box3().setFromObject(this.model), n.x, n.y)
  }

  /** Show or hide whole storeys (by exported group). Only toggles visibility: no geometry changes. */
  setFloorVisibility(visible: boolean[]) {
    this.shadowsDirty = true
    this.groups.forEach((g, i) => (g.visible = visible[i] ?? true))
    this.syncOthersVisibility()
    this.invalidate()
  }

  /** The project's plan geometry for the selected wall. Re-matches the model's generic artwork and re-frames on a new wall. */
  setPlan(plan: PlanContext | null) {
    const wallChanged = plan?.wall.id !== this.plan?.wall.id || plan?.floorId !== this.plan?.floorId
    this.plan = plan
    if (wallChanged) this.aimLight()
    this.refresh(wallChanged)
  }

  private refresh(reframe = false) {
    this.applyMatch()
    const key = `${this.modelId}:${this.plan?.floorId}:${this.plan?.wall.id}`
    if (reframe || key !== this.framedFor) this.frame()
    this.invalidate()
  }

  // -- generic artwork stand-in --

  private colourKey() {
    return (this.plan?.item?.color ?? GENERIC_DEFAULT).toLowerCase()
  }

  /** Every colour a stand-in could have: the selected artwork's and each other saved artwork's. */
  private colourSet() {
    const set = new Set([this.colourKey()])
    for (const o of this.others.values()) set.add(o.data.color.toLowerCase())
    return [...set].sort()
  }

  private restoreGeneric() {
    for (const g of this.generic) {
      if (g.original) {
        g.mesh.geometry.dispose()
        g.mesh.geometry = g.original
        g.original = null
      }
    }
  }

  /** Cluster the solids of every mesh whose material is a generic artwork colour (cached per set of colours). */
  private collectGeneric() {
    const colours = this.colourSet()
    const key = colours.join(',')
    if (key === this.genericColour) return
    this.restoreGeneric()
    this.generic = []
    this.genericColour = key
    this.model?.updateMatrixWorld(true)
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || m.geometry.index) return // FloorGen exports non-indexed triangles; anything else is left alone
      const mat = m.material as THREE.Material
      const colour = colourOfMaterialName(mat.name)
      if (!colour || !colours.includes(colour)) return
      const p = m.geometry.getAttribute('position')
      const world = new Float32Array(p.count * 3)
      const v = new THREE.Vector3()
      for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).toArray(world, i * 3)
      this.generic.push({ mesh: m, solids: clusterSolidTriangles(world), colour, original: null })
    })
  }

  private wallContext(wall: PlanContext['wall'], baseCm: number): WallContext {
    return { frame: frameOf(wall), thickness: wall.thickness, baseCm, wallHeightCm: wall.height }
  }

  /**
   * Hide the stand-ins the model holds for the saved artworks (the selected one and all others) so the textured planes
   * replace them. Each stand-in is claimed by at most one artwork, only exact or unambiguous matches are hidden, and only
   * those triangles are removed, in memory. Everything else in the model is left alone.
   */
  private applyMatch() {
    this.shadowsDirty = true
    this.restoreGeneric()
    this.collectGeneric()
    this.matches = new Map()
    const plan = this.plan
    const saved = plan ? savedPlanItem(plan) : null
    if (!this.model) {
      this.match = { status: 'unsaved', candidates: 0 }
      return
    }
    const flat = this.generic.flatMap((g, mesh) => g.solids.map((solid) => ({ mesh, solid, colour: g.colour })))
    const allowed = (colour: string) => flat.flatMap((f, i) => (f.colour === colour.toLowerCase() ? [i] : []))
    const entries: MatchEntry[] = []
    const selectedId = plan?.item?.id
    if (plan && saved && selectedId) entries.push({ id: selectedId, saved, wall: this.wallContext(plan.wall, plan.baseCm), allowed: allowed(this.colourKey()) })
    for (const o of this.others.values()) {
      if (o.data.id === selectedId || !o.data.wall) continue
      entries.push({ id: o.data.id, saved: o.data.matchItem ?? o.data.item, wall: this.wallContext(o.data.wall, o.data.baseCm), allowed: allowed(o.data.color) })
    }
    this.matches = matchAllArtworks(flat.map((f) => f.solid), entries)
    this.match = selectedId && saved ? (this.matches.get(selectedId) ?? { status: 'unsaved', candidates: 0 }) : { status: 'unsaved', candidates: 0 }
    const drop = new Map<number, Set<number>>()
    for (const r of this.matches.values()) {
      if (r.solid === undefined) continue
      const hit = flat[r.solid]
      const set = drop.get(hit.mesh) ?? new Set<number>()
      for (const t of hit.solid.triangles) set.add(t)
      drop.set(hit.mesh, set)
    }
    for (const [meshIndex, triangles] of drop) {
      const g = this.generic[meshIndex]
      const geo = g.mesh.geometry
      const next = new THREE.BufferGeometry()
      for (const name of Object.keys(geo.attributes)) {
        const a = geo.getAttribute(name)
        next.setAttribute(name, new THREE.BufferAttribute(withoutTriangles(a.array as Float32Array, a.itemSize, triangles), a.itemSize))
      }
      next.computeBoundingSphere()
      next.computeBoundingBox()
      g.original = geo
      g.mesh.geometry = next
    }
  }

  // -- the other saved artworks --

  private groupVisible(index: number | null) {
    return index === null ? true : (this.groups[index]?.visible ?? true)
  }

  /**
   * Draw every saved artwork except the one being edited (that one is `setArtwork`'s, with its unsaved changes). Transforms
   * only move for an edit elsewhere; a texture is rebuilt only when that artwork's image changes. Missing image: a plain
   * frame in the artwork's own colour.
   */
  setOthers(list: OtherArtwork[]) {
    const ids = new Set(list.map((o) => o.id))
    for (const [id, m] of this.others) {
      if (ids.has(id)) continue
      this.scene.remove(m.backing, m.image)
      m.texture?.dispose()
      ;(m.backing.material as THREE.Material).dispose()
      ;(m.image.material as THREE.Material).dispose()
      this.others.delete(id)
    }
    for (const data of list) {
      let m = this.others.get(data.id)
      if (!m) {
        const backing = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({ toneMapped: false }))
        const image = new THREE.Mesh(this.planeGeo, new THREE.MeshBasicMaterial({ toneMapped: false }))
        backing.name = `saved-artwork-frame:${data.id}`
        image.name = `saved-artwork:${data.id}`
        this.scene.add(backing, image)
        m = { backing, image, texture: null, source: null, data }
        this.others.set(data.id, m)
      }
      m.data = data
      if (m.source !== data.image) {
        m.texture?.dispose()
        m.texture = null
        m.source = data.image
        const mat = m.image.material as THREE.MeshBasicMaterial
        if (data.image) {
          const t = new THREE.Texture(data.image)
          t.colorSpace = THREE.SRGBColorSpace
          t.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
          t.needsUpdate = true
          m.texture = t
          mat.map = t
          mat.color.set(0xffffff)
        } else {
          mat.map = null
        }
        mat.needsUpdate = true
      }
      const frame = placementFor(data.item, data.baseCm, 0.15)
      m.backing.position.set(...frame.position)
      m.backing.rotation.set(0, frame.rotationY, 0)
      m.backing.scale.set(data.item.width * CM, data.item.height * CM, 1)
      ;(m.backing.material as THREE.MeshBasicMaterial).color.set(data.color)
      if (data.image && m.texture) {
        const fit = fitContain(data.item.width, data.item.height, data.image.naturalWidth / data.image.naturalHeight)
        const front = placementFor(data.item, data.baseCm, 0.2)
        m.image.position.set(...front.position)
        m.image.rotation.set(0, front.rotationY, 0)
        m.image.scale.set(fit.width * CM, fit.height * CM, 1)
      }
    }
    this.syncOthersVisibility()
    this.applyMatch()
    this.invalidate()
  }

  private syncOthersVisibility() {
    for (const m of this.others.values()) {
      const shown = this.groupVisible(m.data.groupIndex)
      m.backing.visible = shown
      m.image.visible = shown && !!m.texture
    }
  }

  // -- the artwork --

  /**
   * Place (or hide) the previewed artwork. Only transforms change for an edit; the texture is rebuilt only when the image
   * itself changes. `item` is in FloorGen plan units, `image` the local picture (or null for a plain frame).
   */
  setArtwork(item: PlanItem | null, image: HTMLImageElement | null) {
    this.setTexture(image)
    if (!item || !this.plan) {
      this.image.visible = false
      this.backing.visible = false
      this.invalidate()
      return
    }
    const colour = this.colourKey()
    const base = this.plan.baseCm
    // The frame (the saved object's own size) sits just in front of the wall; the image sits 0.5 mm in front of the frame.
    const frame = placementFor(item, base, 0.15)
    this.backing.position.set(...frame.position)
    this.backing.rotation.set(0, frame.rotationY, 0)
    this.backing.scale.set(item.width * CM, item.height * CM, 1)
    ;(this.backing.material as THREE.MeshBasicMaterial).color.set(colour)
    this.backing.visible = true
    if (image && this.texture) {
      const fit = fitContain(item.width, item.height, image.naturalWidth / image.naturalHeight) // whole image, never stretched
      const front = placementFor(item, base, 0.2)
      this.image.position.set(...front.position)
      this.image.rotation.set(0, front.rotationY, 0)
      this.image.scale.set(fit.width * CM, fit.height * CM, 1)
      this.image.visible = true
    } else {
      this.image.visible = false
    }
    this.invalidate()
  }

  private setTexture(image: HTMLImageElement | null) {
    if (image === this.textureSource) return
    this.texture?.dispose()
    this.texture = null
    this.textureSource = image
    const mat = this.image.material as THREE.MeshBasicMaterial
    if (image) {
      const t = new THREE.Texture(image)
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
      t.needsUpdate = true
      this.texture = t
      mat.map = t
      mat.color.set(0xffffff)
    } else {
      mat.map = null
    }
    mat.needsUpdate = true
  }

  // -- camera --

  /** Initial view derived from the wall: aim between the artwork and the wall's centre at furniture height, stand back and above. */
  frame() {
    const plan = this.plan
    if (!plan || this.walk.phase !== 'off') return // never fight the first-person camera
    const f = frameOf(plan.wall)
    const L = f.length * CM
    const mid = new THREE.Vector3(((f.a.x + f.b.x) / 2) * CM, 0, ((f.a.y + f.b.y) / 2) * CM)
    const n = new THREE.Vector3(f.normal.x, 0, f.normal.y)
    const floorY = plan.baseCm * CM
    const focus = this.image.visible || this.backing.visible ? this.backing.position : mid
    const aim = new THREE.Vector3((focus.x + mid.x) / 2, floorY + 0.95, mid.z).addScaledVector(n, 0.28 * L)
    this.controls.target.copy(aim)
    this.camera.position.set(...orbitPosition([aim.x, aim.y, aim.z], { x: n.x, z: n.z }, 22, 46, 1.55 * L))
    this.controls.update()
    this.framedFor = `${this.modelId}:${plan.floorId}:${plan.wall.id}`
    this.invalidate()
  }

  /** What Walk mode should face: the previewed artwork's centre (or the wall's middle without one), and the room-facing normal. */
  walkTarget(): WalkTarget | null {
    const plan = this.plan
    if (!plan) return null
    const n = plan.wall.normal
    if (this.backing.visible) return { artwork: { x: this.backing.position.x / CM, y: this.backing.position.z / CM }, normal: { x: n.x, y: n.y } }
    const a = plan.wall.a
    const b = plan.wall.b
    return { artwork: { x: (a.x + b.x) / 2 + n.x * (plan.wall.thickness / 2 + 1), y: (a.y + b.y) / 2 + n.y * (plan.wall.thickness / 2 + 1) }, normal: { x: n.x, y: n.y } }
  }

  /** For tests and diagnostics: a plain snapshot of what is in the scene. */
  debugState() {
    const v = (o: THREE.Object3D) => o.position.toArray().map((n) => +n.toFixed(5))
    const normal = (o: THREE.Object3D) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion).toArray().map((n) => +n.toFixed(5) + 0)
    return {
      modelId: this.modelId,
      selectedId: this.plan?.item?.id ?? null,
      renderCount: this.renderCount,
      match: this.match,
      groups: this.groups.map((g) => ({ name: g.name, visible: g.visible })),
      artwork: {
        frameVisible: this.backing.visible,
        imageVisible: this.image.visible,
        textured: !!this.texture,
        framePosition: v(this.backing),
        frameSize: [this.backing.scale.x, this.backing.scale.y].map((n) => +n.toFixed(5)),
        imagePosition: v(this.image),
        imageSize: [this.image.scale.x, this.image.scale.y].map((n) => +n.toFixed(5)),
        normal: normal(this.backing),
      },
      others: [...this.others.values()].map((m) => ({
        id: m.data.id,
        visible: m.backing.visible,
        textured: !!m.texture,
        framePosition: v(m.backing),
        frameSize: [m.backing.scale.x, m.backing.scale.y].map((n) => +n.toFixed(5)),
        imagePosition: v(m.image),
        match: this.matches.get(m.data.id)?.status ?? null,
      })),
      genericMeshesWithHiddenSolid: this.generic.filter((g) => g.original).length,
      camera: this.camera.position.toArray().map((n) => +n.toFixed(3)),
      target: this.controls.target.toArray().map((n) => +n.toFixed(3)),
      resources: this.renderer.info.memory,
      walk: this.walk.debugState(),
      look: this.report && { distinctMaterials: this.report.distinctMaterials, colourMismatches: this.report.colourMismatches },
    }
  }

  /** Dispose of the model currently shown (geometries, materials, textures) but keep the renderer. */
  private disposeModel() {
    this.restoreGeneric()
    this.generic = []
    this.genericColour = ''
    if (this.model) {
      this.scene.remove(this.model)
      disposeObject(this.model)
    }
    this.model = null
    this.groups = []
    this.ground.visible = false
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.walk.dispose()
    for (const m of this.others.values()) {
      m.texture?.dispose()
      ;(m.backing.material as THREE.Material).dispose()
      ;(m.image.material as THREE.Material).dispose()
    }
    this.others.clear()
    this.controls.removeEventListener('change', this.onChange)
    this.controls.dispose()
    this.disposeModel()
    this.texture?.dispose()
    this.planeGeo.dispose()
    ;(this.image.material as THREE.Material).dispose()
    ;(this.backing.material as THREE.Material).dispose()
    this.ground.geometry.dispose()
    ;(this.ground.material as THREE.Material).dispose()
    this.sun.shadow.map?.dispose()
    this.env.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

/** Free the GPU resources of everything under `root`. */
export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.geometry.dispose()
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose()
      mat.dispose()
    }
  })
}
