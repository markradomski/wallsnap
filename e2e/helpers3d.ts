import { expect, type Page, type Request } from '@playwright/test'

export type Debug3d = {
  modelId: number
  selectedId: string | null
  others: { id: string; visible: boolean; textured: boolean; framePosition: number[]; frameSize: number[]; match: string | null }[]
  renderCount: number
  match: { status: string; solid?: number; errorMm?: number; candidates: number }
  groups: { name: string; visible: boolean }[]
  artwork: {
    frameVisible: boolean; imageVisible: boolean; textured: boolean
    framePosition: number[]; frameSize: number[]; imagePosition: number[]; imageSize: number[]; normal: number[]
  }
  genericMeshesWithHiddenSolid: number
  camera: number[]
  target: number[]
  resources: { geometries: number; textures: number }
  look: { distinctMaterials: number; colourMismatches: number } | null
  walk: {
    phase: 'off' | 'ready' | 'locked'
    x: number | null; y: number | null; headingDeg: number | null; pitchDeg: number | null; eyeCm: number | null
    loopRunning: boolean; listeners: number; colliders: number
    start: { ok: true; distanceCm: number } | { ok: false; reason: string } | null
  }
}

export const glbFile = (bytes: Uint8Array, name = 'townhouse.glb') => ({ name, mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) })

export const debug3d = (page: Page) => page.evaluate(() => (window as unknown as { __wallsnap3d?: () => unknown }).__wallsnap3d?.() ?? null) as Promise<Debug3d | null>
export const state3d = async (page: Page) => (await debug3d(page))!

/** A real image encoded by the browser itself. */
export async function makeImage(page: Page, w: number, h: number, name = `art-${w}x${h}.png`) {
  const b64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    g.fillStyle = '#d95f02'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#1b9e77'
    g.fillRect(0, 0, w / 2, h / 2)
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    bytes.forEach((x) => (s += String.fromCharCode(x)))
    return btoa(s)
  }, { w, h })
  return { name, mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') }
}

export const WALLS = {
  north: 'Room A — north wall, 600 cm',
  south: 'Room A — south wall, 600 cm',
  west: 'Room A — west wall, 400 cm',
  east: 'Room A — east wall, 400 cm',
  studioEast: 'Studio — east wall, 412 cm', // slanted, ground floor
  studioWest: 'Studio — west wall, 400 cm',
}

export async function openWall(page: Page, floor: 'First floor' | 'Ground floor', wall: string) {
  await page.goto('/')
  await page.locator('select').first().selectOption({ label: floor })
  await page.getByRole('combobox').nth(1).selectOption({ label: wall })
  await expect(page.getByTestId('artwork')).toBeVisible()
}

export const to3d = (page: Page) => page.getByTestId('view-3d').click()
export const to2d = (page: Page) => page.getByTestId('view-2d').click()

export async function importModel(page: Page, bytes: Uint8Array, name = 'townhouse.glb') {
  await page.getByTestId('model-input').setInputFiles(glbFile(bytes, name))
}

/** Waits until a model is loaded and the artwork frame is placed. */
export async function ready3d(page: Page) {
  await expect.poll(async () => (await debug3d(page))?.modelId ?? 0, { timeout: 15000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await debug3d(page))?.artwork.frameVisible ?? false, { timeout: 15000 }).toBe(true)
}

/** Everything the page sends other than GETs. */
export function trackWrites(page: Page) {
  const writes: string[] = []
  const gets: string[] = []
  const on = (r: Request) => (r.method() === 'GET' ? gets : writes).push(`${r.method()} ${r.url()}`)
  page.on('request', on)
  return { writes, gets }
}

export const planOf = async (page: Page, floor: string, wall: string, item?: string) =>
  (await (await page.request.get(`/api/plan?floor=${floor}&wall=${wall}${item ? `&item=${item}` : ''}`)).json()) as {
    floorId: string; baseCm: number
    wall: { a: { x: number; y: number }; b: { x: number; y: number }; thickness: number; height: number; normal: { x: number; y: number } }
    item: { id: string; x: number; y: number; rotation: number; width: number; height: number; depth: number; elevation: number } | null
  }

/** First-principles expectation (cm -> m) of the artwork frame centre for local values, independent of the app's helpers. */
export function expectedFrame(p: Awaited<ReturnType<typeof planOf>>, u: number, v: number, w: number, h: number, depth = 3) {
  const dx = p.wall.b.x - p.wall.a.x, dy = p.wall.b.y - p.wall.a.y, len = Math.hypot(dx, dy)
  const out = p.wall.thickness / 2 + depth + 0.15 // wall face + the picture's depth + 1.5 mm in front of its front face
  return {
    x: (p.wall.a.x + (dx / len) * u + p.wall.normal.x * out) / 100,
    y: (p.baseCm + v + h / 2) / 100,
    z: (p.wall.a.y + (dy / len) * u + p.wall.normal.y * out) / 100,
    size: [w / 100, h / 100],
    normal: [p.wall.normal.x, 0, p.wall.normal.y],
  }
}
