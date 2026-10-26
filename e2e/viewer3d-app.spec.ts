import { expect, test } from '@playwright/test'
import { box, buildGlb, mockTownhouse, type GenericSpec } from '../src/viewer3d/glbFixture'
import {

  WALLS, debug3d, expectedFrame, glbFile, importModel, makeImage, openWall, planOf, ready3d, state3d, to2d, to3d, trackWrites,
} from './helpers3d'

/** Apply is disabled while nothing has changed, so a test that wants to save first makes one small edit if needed. */
const applyAll = async (page: import('@playwright/test').Page) => {
  const b = page.getByRole('button', { name: /^Apply all changes/ })
  if (await b.isDisabled()) {
    const f = page.getByLabel('Bottom elevation')
    await f.fill(String(Number(await f.inputValue()) + 1))
  }
  await b.click()
}


// Every test gets a fresh browser profile (empty IndexedDB). Walls that other specs save on are avoided for anything that saves:
// the slanted Studio east wall is used for saving here; Room A walls are only previewed.

const near = (a: number[], b: number[], tol = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol)

test.describe('lazy loading and the empty state', () => {
  test('the 2D editor never downloads the 3D renderer; entering 3D loads it on demand', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await openWall(page, 'First floor', WALLS.north)
    await page.getByLabel('Horizontal position').fill('200')
    expect(urls.filter((u) => /viewer3d|\/three|three\.js|three_/i.test(u))).toEqual([])
    await to3d(page)
    await expect(page.getByTestId('viewer3d')).toBeVisible()
    expect(urls.filter((u) => /viewer3d|three/i.test(u)).length).toBeGreaterThan(0)
  })

  test('with no model: a clear empty state with an import action, no artwork floating in space, nothing written', async ({ page }) => {
    const { writes } = trackWrites(page)
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await expect(page.getByTestId('viewer-overlay')).toContainText('No 3D model yet')
    await expect(page.getByTestId('viewer-overlay')).toContainText('export your townhouse')
    await expect(page.getByText('Import 3D model…')).toBeVisible()
    expect((await state3d(page)).artwork.frameVisible).toBe(false)
    expect(writes).toEqual([])
  })
})

test.describe('importing a model', () => {
  const rejected: [string, () => ReturnType<typeof glbFile>, RegExp][] = [
    ['a text file named .glb', () => glbFile(new TextEncoder().encode('{"not": "a glb"} and some more text here'), 'fake.glb'), /not a readable GLB/],
    ['a truncated GLB', () => glbFile(mockTownhouse().subarray(0, 60), 'cut.glb'), /not a readable GLB/],
    ['an empty file', () => glbFile(new Uint8Array(0), 'empty.glb'), /empty/],
    ['a file that is not .glb', () => glbFile(mockTownhouse(), 'townhouse.txt'), /Choose a \.glb file/],
    ['a GLB with no geometry', () => glbFile(buildGlb({ floors: [{ name: 'Ground floor' }] }), 'nothing.glb'), /no usable building geometry/],
    ['a GLB that is not a building (no walls)', () => glbFile(buildGlb({ floors: [{ name: 'Props', furniture: [box([0, 0, 0], [3, 1, 3], '#ff0000')] }] }), 'props.glb'), /does not look like a FloorGen building export/],
    ['a model in the wrong units (millimetres)', () => glbFile(buildGlb({ floors: [{ name: 'Ground floor', walls: [box([0, 0, 0], [8000, 2500, 5000], '#f5f2e9')] }] }), 'mm.glb'), /not a plausible building in metres/],
  ]
  for (const [name, file, message] of rejected) {
    test(`rejects ${name} with an actionable message and keeps working`, async ({ page }) => {
      const { writes } = trackWrites(page)
      await openWall(page, 'First floor', WALLS.north)
      await to3d(page)
      await page.getByTestId('model-input').setInputFiles(file())
      await expect(page.getByTestId('import-error')).toContainText(message)
      await expect(page.getByTestId('model-info')).toHaveCount(0)
      await expect(page.getByTestId('viewer-overlay')).toContainText('No 3D model yet')
      // The 2D editor and the artwork are untouched, and nothing was stored or written.
      await to2d(page)
      await expect(page.getByTestId('artwork')).toBeVisible()
      expect(writes).toEqual([])
    })
  }

  test('a valid model renders, shows its filename and date, explains it is a snapshot, and survives a reload', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse(), 'my-townhouse.glb')
    await ready3d(page)
    await expect(page.getByTestId('model-info')).toContainText('my-townhouse.glb')
    await expect(page.getByTestId('model-info')).toContainText(String(new Date().getFullYear()))
    await expect(page.getByTestId('snapshot-note')).toContainText('snapshot')
    await expect(page.getByTestId('snapshot-note')).toContainText('export it again')
    const d = await state3d(page)
    expect(d.groups.map((g) => g.name.replace(/_/g, ' '))).toEqual(['Ground floor', 'First floor', 'Second floor'])
    expect(d.look).toEqual({ distinctMaterials: 3, colourMismatches: 0 }) // materials and colours preserved by the loader

    await page.reload()
    await page.locator('select').first().selectOption({ label: 'First floor' })
    await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.north })
    await expect(page.getByTestId('artwork')).toBeVisible()
    await to3d(page)
    await ready3d(page)
    await expect(page.getByTestId('model-info')).toContainText('my-townhouse.glb') // restored, no re-import
  })

  test('replacing the model swaps it, keeps the same wall, edits and image, and releases the old one', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await page.getByTestId('image-input').setInputFiles(await makeImage(page, 200, 100))
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await page.getByLabel('Horizontal position').fill('333')
    await to3d(page)
    await importModel(page, mockTownhouse(), 'first.glb')
    await ready3d(page)
    const first = await state3d(page)
    for (const name of ['second.glb', 'third.glb', 'fourth.glb']) {
      await importModel(page, mockTownhouse(), name)
      await expect(page.getByTestId('model-info')).toContainText(name)
    }
    const last = await state3d(page)
    expect(last.modelId).toBeGreaterThan(first.modelId)
    // Replacing does not leak GPU geometries: four imports never hold more than one.
    expect(last.resources.geometries).toBeLessThanOrEqual(first.resources.geometries)
    // The wall, the unsaved edit and the image are exactly as they were.
    await expect(page.getByTestId('wall-name')).toContainText('north wall')
    await expect(page.getByLabel('Horizontal position')).toHaveValue('333')
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    expect((await state3d(page)).artwork.textured).toBe(true)
    await expect(page.getByTestId('preview-badge')).toContainText('unsaved')
  })

  test('a replacement that fails to import leaves the current model in place', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse(), 'good.glb')
    await ready3d(page)
    const before = await state3d(page)
    await importModel(page, new TextEncoder().encode('definitely not a model'), 'bad.glb')
    await expect(page.getByTestId('import-error')).toBeVisible()
    await expect(page.getByTestId('model-info')).toContainText('good.glb')
    expect((await state3d(page)).modelId).toBe(before.modelId)
  })
})

test.describe('live preview of unsaved edits (slanted Studio east wall, saving)', () => {
  test('edits in 2D and in the inspector move the 3D artwork at once; nothing is written until Apply, which saves exactly the previewed place', async ({ page }) => {
    const { writes } = trackWrites(page)
    await openWall(page, 'Ground floor', WALLS.studioEast)
    await page.getByTestId('image-input').setInputFiles(await makeImage(page, 300, 200))
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect.poll(() => page.getByLabel('Width').inputValue()).toBe('60')
    await page.getByLabel('Horizontal position').fill('180')
    await page.getByLabel('Bottom elevation').fill('90')
    const plan = await planOf(page, 'f_ground', 'gs_east')

    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    const w = Number(await page.getByLabel('Width').inputValue()), h = Number(await page.getByLabel('Height').inputValue())
    let d = await state3d(page)
    let want = expectedFrame(plan, 180, 90, w, h)
    expect(near(d.artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
    expect(near(d.artwork.frameSize, want.size)).toBe(true)
    expect(near(d.artwork.normal, want.normal, 1e-3)).toBe(true) // faces into the room, on a slanted wall
    expect(d.artwork.textured).toBe(true)
    // The image keeps its 3:2 proportions inside the frame.
    expect(d.artwork.imageSize[0] / d.artwork.imageSize[1]).toBeCloseTo(1.5, 3)
    await expect(page.getByTestId('preview-badge')).toContainText('Previewing unsaved changes')

    // Edit in the inspector while in 3D: the preview follows, without any new request.
    const getsBefore = (await page.evaluate(() => performance.getEntriesByType('resource').length))
    await page.getByLabel('Horizontal position').fill('260')
    want = expectedFrame(plan, 260, 90, w, h)
    await expect.poll(async () => near((await state3d(page)).artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
    await page.getByLabel('Bottom elevation').fill('120')
    want = expectedFrame(plan, 260, 120, w, h)
    await expect.poll(async () => near((await state3d(page)).artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
    await page.getByLabel('Width').fill('90') // locked proportions: height follows, and the frame resizes
    await expect.poll(async () => (await state3d(page)).artwork.frameSize[0]).toBeCloseTo(0.9, 4)
    const h2 = Number(await page.getByLabel('Height').inputValue())
    expect((await state3d(page)).artwork.frameSize[1]).toBeCloseTo(h2 / 100, 4)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').length)).toBe(getsBefore) // not a single request
    expect(writes).toEqual([])

    // Back to 2D, move it there, return to 3D: the new unsaved placement is shown.
    await to2d(page)
    await page.getByTestId('artwork').focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    const u2 = Number(await page.getByLabel('Horizontal position').inputValue())
    expect(u2).toBeCloseTo(310, 0)
    await to3d(page)
    await ready3d(page)
    const w2 = Number(await page.getByLabel('Width').inputValue())
    want = expectedFrame(plan, u2, 120, w2, h2)
    await expect.poll(async () => near((await state3d(page)).artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
    expect(writes).toEqual([])

    // Apply: exactly one write. The saved item sits where the preview showed it.
    await applyAll(page)
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')
    expect(writes.filter((x) => x.startsWith('PUT'))).toHaveLength(1)
    expect(writes).toHaveLength(1)
    d = await state3d(page)
    const saved = await planOf(page, 'f_ground', 'gs_east')
    const it = saved.item!
    const frameCm = [d.artwork.framePosition[0] * 100, d.artwork.framePosition[2] * 100]
    const out = saved.wall.thickness / 2 + it.depth + 0.15
    expect(frameCm[0]).toBeCloseTo(it.x + saved.wall.normal.x * (it.depth / 2 + 0.15), 1)
    expect(frameCm[1]).toBeCloseTo(it.y + saved.wall.normal.y * (it.depth / 2 + 0.15), 1)
    expect(out).toBeGreaterThan(0)
    await expect(page.getByTestId('preview-badge')).toContainText('saved placement')
  })

  test('a missing artwork image shows a plain frame with a note, and edits still move it', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    const d = await state3d(page)
    expect(d.artwork.textured).toBe(false)
    expect(d.artwork.imageVisible).toBe(false)
    expect(d.artwork.frameVisible).toBe(true)
    await expect(page.getByTestId('viewer-note').filter({ hasText: 'plain frame' })).toBeVisible()
    await page.getByLabel('Horizontal position').fill('250')
    await expect.poll(async () => (await state3d(page)).artwork.framePosition[0]).toBeCloseTo((100 + 250) / 100, 3)
  })
})

test.describe('the model\'s generic artwork stand-in', () => {
  /** Saves an artwork on the Studio east wall, then returns what FloorGen holds, to build models around. */
  async function saved(page: import('@playwright/test').Page) {
    await openWall(page, 'Ground floor', WALLS.studioEast)
    await applyAll(page)
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')
    const plan = await planOf(page, 'f_ground', 'gs_east')
    return plan.item!
  }
  const spec = (it: { x: number; y: number; width: number; height: number; elevation: number; rotation: number }, over: Partial<GenericSpec> = {}): GenericSpec =>
    ({ floor: 0, x: it.x, y: it.y, width: it.width, height: it.height, elevation: it.elevation, rotation: it.rotation, ...over })

  test('an up-to-date model: the stand-in is matched exactly and hidden, with no warning', async ({ page }) => {
    const it = await saved(page)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800, generic: [spec(it)] }))
    await ready3d(page)
    const d = await state3d(page)
    expect(d.match.status).toBe('exact')
    expect(d.match.errorMm!).toBeLessThan(0.5)
    expect(d.genericMeshesWithHiddenSolid).toBe(1)
    await expect(page.getByTestId('viewer-note').filter({ hasNotText: 'No image' })).toHaveCount(0)
  })

  test('a stale model (the artwork moved since export): the old stand-in is hidden and a warning says why', async ({ page }) => {
    const it = await saved(page)
    await to3d(page)
    // exported when the artwork hung 40 cm further along the wall, and smaller
    const plan = await planOf(page, 'f_ground', 'gs_east')
    const len = Math.hypot(plan.wall.b.x - plan.wall.a.x, plan.wall.b.y - plan.wall.a.y)
    const tx = (plan.wall.b.x - plan.wall.a.x) / len, ty = (plan.wall.b.y - plan.wall.a.y) / len
    await importModel(page, mockTownhouse({ x1Cm: 800, generic: [spec(it, { x: it.x + tx * 40, y: it.y + ty * 40, width: it.width - 10 })] }))
    await ready3d(page)
    const d = await state3d(page)
    expect(d.match.status).toBe('stale')
    expect(d.genericMeshesWithHiddenSolid).toBe(1)
    await expect(page.getByTestId('viewer-note').filter({ hasText: 'exported before this artwork changed' })).toBeVisible()
  })

  test('ambiguous (two stand-ins on the wall, neither exact): nothing is hidden, a warning explains', async ({ page }) => {
    const it = await saved(page)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800, generic: [spec(it, { x: it.x + 20, y: it.y - 76, elevation: 40 }), spec(it, { x: it.x - 20, y: it.y + 76, elevation: 150 })] }))
    await ready3d(page)
    const d = await state3d(page)
    expect(d.match.status).toBe('ambiguous')
    expect(d.genericMeshesWithHiddenSolid).toBe(0)
    await expect(page.getByTestId('viewer-note').filter({ hasText: 'cannot tell which one' })).toBeVisible()
  })

  test('a model that does not contain the artwork: nothing is hidden and a warning suggests re-exporting', async ({ page }) => {
    await saved(page)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800, generic: [] }))
    await ready3d(page)
    expect((await state3d(page)).match.status).toBe('none')
    await expect(page.getByTestId('viewer-note').filter({ hasText: 'not in the 3D model' })).toBeVisible()
  })

  test('an artwork that has never been saved has no stand-in to hide, and no warning', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse({ generic: [{ floor: 1, x: 500, y: 109, width: 100, height: 60, elevation: 100, rotation: 0 }] })) // someone else's picture
    await ready3d(page)
    const d = await state3d(page)
    expect(['unsaved', 'none']).toContain(d.match.status)
    expect(d.genericMeshesWithHiddenSolid).toBe(0) // unrelated geometry is never removed
  })
})

test.describe('floor visibility', () => {
  test('inspect hides floors above the selected one; the control restores the whole building without moving the artwork', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    const vis = async () => (await state3d(page)).groups.map((g) => g.visible)
    expect(await vis()).toEqual([true, true, false])
    const before = (await state3d(page)).artwork
    await page.getByLabel('Show upper floors').check()
    await expect.poll(vis).toEqual([true, true, true])
    expect((await state3d(page)).artwork).toEqual(before) // placement is independent of what is shown
    await page.getByLabel('Show upper floors').uncheck()
    await expect.poll(vis).toEqual([true, true, false])
  })

  test('on the top floor there is nothing above to hide, and on the ground floor both upper floors are', async ({ page }) => {
    await openWall(page, 'Ground floor', WALLS.studioWest)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    expect((await state3d(page)).groups.map((g) => g.visible)).toEqual([true, false, false])
    await expect(page.getByLabel('Show upper floors')).toBeEnabled()
    // The selected storey follows the Floor selector while staying in 3D.
    await page.locator('select').first().selectOption({ label: 'First floor' })
    await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.north })
    await expect.poll(async () => (await debug3d(page))?.groups.map((g) => g.visible)).toEqual([true, true, false])
  })
})

test.describe('wall directions', () => {
  for (const [label, floor, wall, floorId, wallId] of [
    ['north (A west)', 'First floor', WALLS.north, 'f_first', 'fl_north'],
    ['south (A east, reversed)', 'First floor', WALLS.south, 'f_first', 'fl_south'],
    ['west', 'First floor', WALLS.west, 'f_first', 'fl_west'],
    ['east', 'First floor', WALLS.east, 'f_first', 'fl_east'],
    ['slanted', 'Ground floor', WALLS.studioEast, 'f_ground', 'gs_east'],
  ] as const) {
    test(`${label}: the preview hangs flush on the room face, facing in, at the right distance from endpoint A`, async ({ page }) => {
      await openWall(page, floor, wall)
      await page.getByLabel('Horizontal position').fill('150')
      await page.getByLabel('Bottom elevation').fill('100')
      await to3d(page)
      await importModel(page, mockTownhouse({ x1Cm: 800 }))
      await ready3d(page)
      const plan = await planOf(page, floorId, wallId)
      const w = Number(await page.getByLabel('Width').inputValue()), h = Number(await page.getByLabel('Height').inputValue())
      const want = expectedFrame(plan, 150, 100, w, h)
      const d = await state3d(page)
      expect(near(d.artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
      expect(near(d.artwork.normal, want.normal, 1e-3)).toBe(true)
      // And it is on the room's side of the wall: from the wall towards the room is the direction it faces.
      const wallMid = [(plan.wall.a.x + plan.wall.b.x) / 200, (plan.wall.a.y + plan.wall.b.y) / 200]
      const toFrame = [d.artwork.framePosition[0] - wallMid[0], d.artwork.framePosition[2] - wallMid[1]]
      expect(toFrame[0] * d.artwork.normal[0] + toFrame[1] * d.artwork.normal[2]).toBeGreaterThan(0)
    })
  }
})

test.describe('robustness', () => {
  test('a wall outside the model (stale or foreign export) shows a warning instead of a floating picture', async ({ page }) => {
    await openWall(page, 'Ground floor', WALLS.studioEast) // reaches x = 800 cm
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 700 })) // a model only 700 cm wide
    await ready3d(page)
    await expect(page.getByTestId('viewer-note').filter({ hasText: 'outside this 3D model' })).toBeVisible()
  })

  test('repeated 2D/3D toggling keeps state, never stacks canvases, loops or listeners, and writes nothing', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    const { writes } = trackWrites(page)
    await openWall(page, 'First floor', WALLS.north)
    await page.getByTestId('image-input').setInputFiles(await makeImage(page, 200, 100))
    await page.getByLabel('Horizontal position').fill('222')
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    for (let i = 0; i < 8; i++) {
      await to2d(page)
      await expect(page.getByTestId('artwork')).toBeVisible()
      await expect(page.getByLabel('Horizontal position')).toHaveValue('222')
      expect(await page.locator('canvas').count()).toBe(0) // the renderer is gone while in 2D
      await to3d(page)
      await ready3d(page)
      expect(await page.locator('canvas').count()).toBe(1) // exactly one
    }
    // After all that, the scene still reacts, and an idle scene does not keep rendering (no leaked animation loop).
    await page.getByLabel('Horizontal position').fill('240')
    await expect.poll(async () => (await state3d(page)).artwork.framePosition[0]).toBeCloseTo((100 + 240) / 100, 3)
    await page.waitForTimeout(1000) // let the last invalidated frame land
    const idle = (await state3d(page)).renderCount
    await page.waitForTimeout(500)
    expect((await state3d(page)).renderCount).toBe(idle)
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([])
    expect(writes).toEqual([])
    // The edit survived every toggle and the artwork is still unsaved: the badge says so.
    await expect(page.getByTestId('preview-badge')).toContainText('unsaved')
  })

  test('orbit, pan and zoom change only the camera, and write nothing', async ({ page }) => {
    const { writes } = trackWrites(page)
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    const before = await state3d(page)
    const box = (await page.getByTestId('viewer3d-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 })
    await page.mouse.up()
    await page.mouse.wheel(0, -400)
    await expect.poll(async () => near((await state3d(page)).camera, before.camera, 0.05)).toBe(false)
    expect((await state3d(page)).artwork).toEqual(before.artwork) // the artwork did not move with the camera
    expect(writes).toEqual([])
  })

  test('without WebGL the 3D view explains itself and the 2D editor keeps working', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (/webgl/i.test(type)) return null
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest) as never
      } as typeof orig
    })
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await expect(page.getByTestId('viewer-overlay')).toContainText('3D preview is unavailable')
    await expect(page.getByTestId('viewer-overlay')).toContainText('WebGL')
    await to2d(page)
    await page.getByLabel('Horizontal position').fill('210')
    await expect(page.getByTestId('artwork')).toBeVisible()
    await to3d(page)
    await expect(page.getByTestId('viewer-overlay')).toContainText('3D preview is unavailable')
    await expect(page.getByLabel('Horizontal position')).toHaveValue('210')
  })

  test('a corrupted stored model is reported, can be replaced, and does not break the editor', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await page.evaluate(() => new Promise<void>((resolve) => {
      const req = indexedDB.open('wallsnap-models', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('models')
      req.onsuccess = () => {
        const tx = req.result.transaction('models', 'readwrite')
        tx.objectStore('models').put({ blob: 'garbage', name: 'x.glb', size: 1, importedAt: 1, summary: { floors: 1, triangles: 1 } }, 'mock-project/townhouse-model')
        tx.oncomplete = () => { req.result.close(); resolve() }
      }
    }))
    await to3d(page)
    await expect(page.getByTestId('viewer-overlay')).toContainText('damaged')
    await importModel(page, mockTownhouse(), 'fresh.glb')
    await ready3d(page)
    await expect(page.getByTestId('model-info')).toContainText('fresh.glb')
  })
})

test.describe('layout', () => {
  test('narrow screens: the 3D view fits, the toolbar and inspector stay reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const canvas = (await page.getByTestId('viewer3d-canvas').boundingBox())!
    expect(canvas.width).toBeGreaterThan(300)
    expect(canvas.height).toBeGreaterThan(300)
    await expect(page.getByTestId('view-2d')).toBeVisible()
    await expect(page.getByTestId('view-3d')).toBeVisible()
    await expect(page.getByLabel('Show upper floors')).toBeVisible()
    await page.getByLabel('Horizontal position').scrollIntoViewIfNeeded()
    await expect(page.getByLabel('Horizontal position')).toBeVisible()
  })

  test('the Floor and Wall selectors and themes keep working in 3D', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse())
    await ready3d(page)
    await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.south })
    await expect(page.getByTestId('wall-name')).toContainText('south wall')
    await expect(page.getByTestId('view-3d')).toHaveAttribute('aria-pressed', 'true') // stays in 3D
    const south = await planOf(page, 'f_first', 'fl_south')
    const w = Number(await page.getByLabel('Width').inputValue()), h = Number(await page.getByLabel('Height').inputValue())
    const u = Number(await page.getByLabel('Horizontal position').inputValue())
    const v = Number(await page.getByLabel('Bottom elevation').inputValue())
    const want = expectedFrame(south, u, v, w, h)
    await expect.poll(async () => near((await state3d(page)).artwork.framePosition, [want.x, want.y, want.z])).toBe(true)
    await page.getByRole('button', { name: 'Dark' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    expect((await debug3d(page))!.modelId).toBeGreaterThan(0) // the scene survived the theme change
  })
})
