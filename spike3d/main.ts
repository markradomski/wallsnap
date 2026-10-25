/**
 * Phase 5A feasibility spike: show a WallSnap artwork image, at its saved FloorGen size and position, inside FloorGen's
 * exported 3D townhouse. Standalone and development-only; the production 2D editor does not use any of this.
 *
 * Data comes from three places: the GLB (geometry), the spike server (the live artwork's plan coordinates), and this
 * browser's IndexedDB (the artwork image, written by WallSnap on the same origin).
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createImageStore, idbKV, itemKey } from '../src/imageStore'
import { clusterSolids } from './solids'
import { CM, boxError, expectedAabbCm, fitContain, placementFor, type Aabb, type PlanItem } from './transform'

const API = 'http://localhost:8788'
const hud = document.getElementById('hud')!
const say = (text: string, error = false) => {
  hud.textContent = text
  hud.classList.toggle('error', error)
}

interface ArtworkResponse {
  project: string
  rev: number
  floor: { id: string; name: string; baseCm: number }
  wall: { id: string; label: string; length: number; height: number; thickness: number; a: { x: number; y: number }; b: { x: number; y: number }; normal: { x: number; y: number } }
  item: PlanItem & { id: string; mirror: boolean }
  wallCoords: { u: number; perp: number }
}

/**
 * Renders the plane face-on into an offscreen target and compares it, cell by cell, with the source image under four
 * hypotheses: as-is, mirrored, flipped, both. The correct reading is the one with the smallest error. This is objective,
 * independent of which picture is stored, and also fails if the generic solid were hiding the plane.
 */
function orientationCheck(
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, plane: THREE.Mesh, normal: THREE.Vector3, size: { w: number; h: number }, img: HTMLImageElement,
) {
  const COLS = 12, ROWS = 8
  const W = COLS * 8, H = ROWS * 8
  const rt = new THREE.WebGLRenderTarget(W, H, { colorSpace: THREE.SRGBColorSpace })
  const cam = new THREE.OrthographicCamera(-size.w / 2, size.w / 2, size.h / 2, -size.h / 2, 0.01, 10)
  cam.position.copy(plane.position).addScaledVector(normal, 1)
  cam.up.set(0, 1, 0)
  cam.lookAt(plane.position)
  renderer.setRenderTarget(rt)
  renderer.render(scene, cam)
  const px = new Uint8Array(W * H * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px)
  renderer.setRenderTarget(null)
  rt.dispose()

  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0, W, H) // the image stretched to the sampling grid: a fractional position means the same thing in both
  const src = g.getImageData(0, 0, W, H).data

  // Mean absolute channel error over the grid; `fx/fy` choose how the expected image is read.
  const error = (flipX: boolean, flipY: boolean) => {
    let sum = 0, n = 0
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const x = Math.floor(((i + 0.5) / COLS) * W), yDown = Math.floor(((j + 0.5) / ROWS) * H)
      const sx = flipX ? W - 1 - x : x, sy = flipY ? H - 1 - yDown : yDown
      const r = (H - 1 - yDown) * W + x // render-target rows start at the bottom
      for (let k = 0; k < 3; k++) { sum += Math.abs(px[r * 4 + k] - src[(sy * W + sx) * 4 + k]); n++ }
    }
    return sum / n
  }
  const asIs = error(false, false), mirrored = error(true, false), flipped = error(false, true), both = error(true, true)
  return { asIs, mirrored, flipped, both, correct: asIs < 12 && asIs < Math.min(mirrored, flipped, both) * 0.6 }
}

async function main() {
  const view = document.getElementById('view')!
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  view.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0d1118)
  // Just enough light to read the PBR materials; the artwork itself is unlit so its colours stay true.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(3, 10, 12)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.4), sun)
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100)
  const controls = new OrbitControls(camera, renderer.domElement)
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight)
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
  }
  window.addEventListener('resize', resize)
  resize()
  renderer.setAnimationLoop(() => renderer.render(scene, camera))

  // 1. The live artwork, in FloorGen plan coordinates (never hard-coded here).
  say('Loading the live artwork from FloorGen…')
  const res = await fetch(`${API}/artwork`)
  const art = (await res.json()) as ArtworkResponse & { error?: string }
  if (!res.ok) throw new Error(art.error ?? `artwork request failed (${res.status})`)
  const { item, floor } = art

  // 2. The exported model.
  say('Loading the townhouse model…')
  const gltf = await new GLTFLoader().loadAsync(`${API}/model.glb`, (p) => p.total && say(`Loading the townhouse model… ${Math.round((p.loaded / p.total) * 100)}%`))
  scene.add(gltf.scene)
  // Look into the first-floor room from above: hide the floor over it. (Its geometry is untouched.)
  // (GLTFLoader sanitises node names, turning spaces into underscores, so match either form.)
  const floorGroup = (prefix: string) => gltf.scene.children.find((c) => new RegExp(`^${prefix}[ _]Floor`, 'i').test(c.name))
  const upper = floorGroup('Second')
  if (upper) upper.visible = false

  // 3. Verify the transform against the GLB's own geometry: find the generic-artwork solids (FloorGen colour #4b5a70) on
  //    the first floor and compare the one for this item with the box its plan data predicts.
  const first = floorGroup('First')
  if (!first) throw new Error('The model has no first-floor group.')
  const verts: number[] = []
  first.traverse((o) => {
    const m = o as THREE.Mesh
    const mat = m.material as THREE.Material | undefined
    if (!m.isMesh || !mat?.name.startsWith('#4b5a70')) return
    const p = m.geometry.getAttribute('position')
    const v = new THREE.Vector3()
    for (let i = 0; i < p.count; i++) verts.push(...v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld).toArray())
  })
  const expected = expectedAabbCm(item, floor.baseCm)
  const solids: Aabb[] = clusterSolids(verts).map((b) => ({ min: b.min.map((n) => n / CM) as Aabb['min'], max: b.max.map((n) => n / CM) as Aabb['max'] }))
  const best = solids.map((b) => boxError(b, expected)).sort((a, b) => a - b)[0]

  // 4. The artwork image, from this browser's local store.
  say('Reading the stored artwork image…')
  const stored = await createImageStore(idbKV).get(itemKey(art.project, item.id))
  if (!stored.ok || !stored.value) {
    throw new Error(`No stored image for artwork ${item.id}. Upload one in WallSnap (same browser, http://localhost:5173) and reload.`)
  }
  const url = URL.createObjectURL(stored.value.blob)
  const img = await new Promise<HTMLImageElement>((ok, bad) => {
    const i = new Image()
    i.onload = () => ok(i)
    i.onerror = () => bad(new Error('The stored image could not be decoded.'))
    i.src = url
  })
  const ratio = img.naturalWidth / img.naturalHeight

  // 5. One textured plane, flush in front of the generic solid, at the saved size and position.
  const texture = new THREE.Texture(img)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
  texture.needsUpdate = true
  const fit = fitContain(item.width, item.height, ratio) // whole image, never cropped or stretched inside the frame
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(fit.width * CM, fit.height * CM),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), // unlit; front face only (faces into the room)
  )
  const placement = placementFor(item, floor.baseCm)
  plane.position.set(...placement.position)
  plane.rotation.y = placement.rotationY
  plane.name = 'wallsnap-artwork'
  scene.add(plane)

  // 5b. Does it face the room, sit just in front of the solid, and read upright, unmirrored and unobscured?
  const nVec = new THREE.Vector3(...placement.normal)
  const best_ = solids.map((b) => ({ b, e: boxError(b, expected) })).sort((a, b) => a.e - b.e)[0]?.b
  const halfDepthCm = best_ ? (Math.abs(nVec.x) > 0.5 ? best_.max[0] - best_.min[0] : best_.max[2] - best_.min[2]) / 2 : NaN
  const solidCentreCm = best_ ? [(best_.min[0] + best_.max[0]) / 2, (best_.min[2] + best_.max[2]) / 2] : [NaN, NaN]
  const alongNormalCm = (plane.position.x / CM - solidCentreCm[0]) * nVec.x + (plane.position.z / CM - solidCentreCm[1]) * nVec.z
  const frontGapMm = (alongNormalCm - halfDepthCm) * 10 // plane's distance in front of the solid's front face
  const inFootprint = best_ ? plane.position.y / CM >= best_.min[1] - 1e-6 && plane.position.y / CM <= best_.max[1] + 1e-6 : false
  const orient = orientationCheck(renderer, scene, plane, nVec, { w: fit.width * CM, h: fit.height * CM }, img)

  // 6. A useful view, derived from the wall itself: stand back and well above the middle of the wall, over the near
  //    wall, looking down into the room at the picture's wall. Distances scale with the wall's length.
  const L = art.wall.length * CM
  const mid = new THREE.Vector3(((art.wall.a.x + art.wall.b.x) / 2) * CM, 0, ((art.wall.a.y + art.wall.b.y) / 2) * CM)
  const n = new THREE.Vector3(art.wall.normal.x, 0, art.wall.normal.y) // plan normal == world (X, Z)
  const floorY = floor.baseCm * CM
  controls.target.copy(mid).addScaledVector(n, 0.3 * L).setY(floorY + 0.7)
  camera.position.copy(mid).addScaledVector(n, 1.2 * L).setY(floorY + 0.8 * L)
  controls.update()
  const centre = new THREE.Vector3(...placement.position)

  const summary = {
    ready: true,
    itemId: item.id,
    savedCm: { x: item.x, y: item.y, width: item.width, height: item.height, elevation: item.elevation, rotation: item.rotation, depth: item.depth, mirrorFlag: item.mirror },
    floorBaseCm: floor.baseCm,
    solidsInGlb: solids.length,
    solidMatchErrorMm: best * 10,
    frontGapMm,
    planeCentreInsideSolidHeight: inFootprint,
    orientation: orient,
    image: { name: stored.value.name, px: [img.naturalWidth, img.naturalHeight], ratio },
    planeMetres: { width: fit.width * CM, height: fit.height * CM },
    planeCentre: placement.position,
    normal: placement.normal,
    camera: camera.position.toArray(),
    target: controls.target.toArray(),
    centre: centre.toArray(),
  }
  ;(window as unknown as { __spike: unknown; __scene: THREE.Scene; __camera: THREE.Camera; __controls: OrbitControls }).__spike = summary
  Object.assign(window, { __scene: scene, __camera: camera, __controls: controls })
  say(
    `Loaded: ${gltf.scene.children.length} floor groups · live artwork ${item.id}\n` +
      `Saved size ${item.width} × ${item.height} cm, centre (${item.x}, ${item.y}) cm, elevation ${item.elevation} cm on ${floor.name}\n` +
      `GLB solid vs plan prediction: ${best < 0.5 ? 'match' : 'MISMATCH'} (largest error ${(best * 10).toFixed(2)} mm, ${solids.length} solids)\n` +
      `Image ${stored.value.name} ${img.naturalWidth}×${img.naturalHeight} (ratio ${ratio.toFixed(2)}) → plane ${(fit.width * CM).toFixed(3)} × ${(fit.height * CM).toFixed(3)} m, ${frontGapMm.toFixed(1)} mm in front of the solid\n` +
      `Face-on render vs source image: as-is ${orient.asIs.toFixed(1)} · mirrored ${orient.mirrored.toFixed(1)} · flipped ${orient.flipped.toFixed(1)} → ${orient.correct ? 'upright, not mirrored, not obscured' : 'CHECK ORIENTATION'}`,
  )
}

main().catch((e) => {
  console.error(e)
  say(`Could not show the artwork: ${e instanceof Error ? e.message : String(e)}`, true)
  ;(window as unknown as { __spike: unknown }).__spike = { ready: false, error: String(e) }
})
