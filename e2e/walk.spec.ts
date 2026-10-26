import { expect, test, type Page } from '@playwright/test'
import { mockTownhouse } from '../src/viewer3d/glbFixture'
import { WALLS, debug3d, importModel, openWall, ready3d, state3d, to2d, to3d, trackWrites } from './helpers3d'

// Mock Room A (first floor): inside faces at x 107.5..692.5, y 107.5..492.5, so the walker's centre stays within 132.5..667.5 / 132.5..467.5.
// Sofa: x 355..445, y 200..400. Stair below rises through x 440..660, y 390..470 (incl. well gap). Doorway to the Hall in the east wall: y 395..485.
const place = (page: Page, x: number, y: number, deg: number) =>
  page.evaluate(([a, b, c]) => (window as unknown as { __wallsnapWalkPlace: (x: number, y: number, d: number) => boolean }).__wallsnapWalkPlace(a, b, c), [x, y, deg] as const)

async function openWalk(page: Page, floor: 'First floor' | 'Ground floor' = 'First floor', wall = WALLS.north) {
  await openWall(page, floor, wall)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  await page.getByTestId('nav-walk').click()
  await expect.poll(async () => (await state3d(page)).walk.phase).not.toBe('off')
  await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
}

/** Hold keys until `done` is true (or time runs out), then release them. Real key events, real frames. */
async function hold(page: Page, keys: string[], done: () => Promise<boolean>, ms = 6000) {
  for (const k of keys) await page.keyboard.down(k)
  try {
    await expect.poll(done, { timeout: ms, intervals: [50] }).toBe(true)
  } finally {
    for (const k of keys) await page.keyboard.up(k)
  }
}
const pos = async (page: Page) => {
  const w = (await state3d(page)).walk
  return { x: w.x!, y: w.y!, h: w.headingDeg! }
}
/** Hold a key for a fixed time and report where the walker ended up. */
async function walkFor(page: Page, keys: string[], ms: number) {
  for (const k of keys) await page.keyboard.down(k)
  await page.waitForTimeout(ms)
  for (const k of keys) await page.keyboard.up(k)
  await page.waitForTimeout(80)
  return pos(page)
}

test.describe('Walk mode', () => {
  test('is offered only with a model; entering starts at eye level, in front of the artwork, looking at it', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await expect(page.getByTestId('nav-walk')).toHaveCount(0)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    await expect(page.getByTestId('nav-orbit')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('nav-walk').click()
    await expect(page.getByTestId('nav-walk')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('walk-hint')).toContainText('160 cm')
    await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
    const d = await state3d(page)
    expect(d.walk.start).toMatchObject({ ok: true })
    expect(d.walk.eyeCm).toBe(250 + 160) // first floor base + eye height
    expect(d.camera[1]).toBeCloseTo(4.1, 3)
    // the camera is in the artwork's room, 2-3 m from it, and looks straight at it
    const art = d.artwork.framePosition
    const dx = art[0] * 100 - d.walk.x!, dy = art[2] * 100 - d.walk.y!
    const dist = Math.hypot(dx, dy)
    expect(dist).toBeGreaterThan(150)
    expect(dist).toBeLessThan(350)
    const heading = (d.walk.headingDeg! * Math.PI) / 180
    expect((Math.cos(heading) * dx + Math.sin(heading) * dy) / dist).toBeGreaterThan(0.999)
    expect(d.walk.x).toBeGreaterThan(107.5)
    expect(d.walk.x).toBeLessThan(692.5)
    expect(d.walk.y).toBeLessThan(492.5)
  })

  test('stops at walls from inside, whatever the direction, and slides along them', async ({ page }) => {
    await openWalk(page)
    // straight into the east wall
    expect(await place(page, 550, 300, 0)).toBe(true)
    const wall = await walkFor(page, ['KeyW'], 2200)
    expect(wall.x).toBeCloseTo(667.5, 0)
    expect(wall.y).toBeCloseTo(300, 0)
    // diagonally into it (up and right): the along-wall part of the move continues, up to the corner
    expect(await place(page, 550, 300, -45)).toBe(true)
    const slide = await walkFor(page, ['KeyW'], 3000)
    expect(slide.x).toBeCloseTo(667.5, 0)
    expect(slide.y).toBeCloseTo(132.5, 0)
    // backwards and sideways into the north wall
    expect(await place(page, 550, 200, 90)).toBe(true) // facing +y: S goes -y
    expect((await walkFor(page, ['KeyS'], 2200)).y).toBeCloseTo(132.5, 0)
    expect(await place(page, 550, 300, 0)).toBe(true) // facing +x: A strafes to -y
    expect((await walkFor(page, ['KeyA'], 2600)).y).toBeCloseTo(132.5, 0)
  })

  test('solid wall blocks beside a window and at an exterior door; the stair well blocks like a hole in the floor', async ({ page }) => {
    await openWalk(page)
    expect(await place(page, 300, 300, -90)).toBe(true) // under the north window (sill 90)
    expect((await walkFor(page, ['KeyW'], 2500)).y).toBeCloseTo(132.5, 0)
    expect(await place(page, 550, 440, 90)).toBe(true) // at the south wall's door, which leads outside
    expect((await walkFor(page, ['KeyW'], 1500)).y).toBeCloseTo(467.5, 0)
    // the stair from the ground floor rises through x 140..360, y 390..470 (with its gap): not a place to stand or walk
    expect(await place(page, 250, 430, 0)).toBe(false)
    expect(await place(page, 250, 300, 90)).toBe(true)
    expect((await walkFor(page, ['KeyW'], 2500)).y).toBeCloseTo(390 - 25, 0)
  })

  test('cannot walk through the sofa, can walk around it, and keeps going', async ({ page }) => {
    await openWalk(page)
    expect(await place(page, 250, 300, 0)).toBe(true)
    const stuck = await walkFor(page, ['KeyW'], 2500)
    expect(stuck.x).toBeCloseTo(355 - 25, 0) // stopped at the sofa
    // turn left to face up the plan (the stair well is below the sofa), walk past the sofa's end, turn right, and carry on across
    await hold(page, ['ArrowLeft'], async () => (await pos(page)).h <= -88)
    await hold(page, ['KeyW'], async () => (await pos(page)).y < 172)
    await hold(page, ['ArrowRight'], async () => (await pos(page)).h >= -2)
    await hold(page, ['KeyW'], async () => (await pos(page)).x > 445 + 25 + 10)
    expect((await pos(page)).y).toBeLessThan(200) // it went over the top of the sofa, not through it
  })

  test('walks through a real doorway into the next room; the solid wall beside it still blocks', async ({ page }) => {
    await openWalk(page)
    expect(await place(page, 560, 300, 0)).toBe(true)
    expect((await walkFor(page, ['KeyW'], 1500)).x).toBeCloseTo(667.5, 0) // beside the doorway (y 395..485): solid
    expect(await place(page, 560, 440, 0)).toBe(true) // lined up with it
    const through = await walkFor(page, ['KeyW'], 2200)
    expect(through.x).toBeGreaterThan(740) // in the Hall
    expect(through.y).toBeCloseTo(440, 0)
    // the Hall is bounded too: its far wall stops us
    const far = await walkFor(page, ['KeyW'], 2500)
    expect(far.x).toBeCloseTo(892.5 - 25, 0)
    // and back out the same way
    await hold(page, ['KeyS'], async () => (await pos(page)).x < 680, 8000)
    expect((await pos(page)).x).toBeLessThan(680)
  })

  test('ground floor: the slanted outer wall and the stair are obstacles', async ({ page }) => {
    await openWalk(page, 'Ground floor', WALLS.studioEast)
    // Ground floor has no interior door in this mock: crossing the slanted east wall must be impossible
    expect(await place(page, 500, 300, 0)).toBe(true)
    const w = await walkFor(page, ['KeyW'], 4000)
    // distance from the wall's centreline (800,100)-(700,500), which must stay at least half its thickness plus the body radius
    const away = ((w.x - 800) * 400 + (w.y - 100) * 100) / Math.hypot(100, 400) // signed: negative on the room side... use magnitude
    expect(Math.abs(away)).toBeGreaterThanOrEqual(7.5 + 25 - 0.01)
    expect(Math.abs(away)).toBeLessThan(40) // it pressed against the wall and slid, it did not stop short or pass through
    // the stair is an obstacle on the ground floor: (250, 430), run x 150..350, y 400..460
    expect(await place(page, 250, 430, 0)).toBe(false)
    expect(await place(page, 250, 250, 90)).toBe(true)
    expect((await walkFor(page, ['KeyW'], 2500)).y).toBeCloseTo(400 - 25, 0)
  })

  test('clicking the view captures the pointer; releasing it keeps Walk on; Exit Walk returns the orbit camera untouched', async ({ page }) => {
    // Headless Chromium refuses real pointer lock (WrongDocumentError), so the browser's lock API is stood in for here: the app's
    // wiring (request on click, react to pointerlockchange, release on exit) is real, the lock itself is simulated. Real capture
    // is checked by hand in the live run.
    await page.addInitScript(() => {
      let locked: Element | null = null
      Object.defineProperty(document, 'pointerLockElement', { get: () => locked, configurable: true })
      Element.prototype.requestPointerLock = function (this: Element) {
        locked = this
        queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')))
      } as never
      document.exitPointerLock = () => {
        locked = null
        queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')))
      }
    })
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    const orbitBefore = await state3d(page)
    await page.getByTestId('nav-walk').click()
    await expect(page.getByTestId('walk-status')).toContainText('Click the view')
    await page.getByTestId('viewer3d-canvas').click()
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('locked')
    await expect(page.getByTestId('walk-status')).toContainText('Mouse captured')
    await expect(page.getByTestId('walk-hint')).toHaveCount(0) // shown only until the first capture
    // mouse look turns the view (movementX comes from the real mouse events)
    const h0 = (await state3d(page)).walk.headingDeg!
    await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 120, movementY: -40 })))
    await expect.poll(async () => (await state3d(page)).walk.headingDeg!).toBeGreaterThan(h0 + 10)
    // releasing the pointer (what Escape does in the browser) leaves Walk mode on
    await page.evaluate(() => document.exitPointerLock())
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('ready')
    await expect(page.getByTestId('walk-status')).toContainText('Click the view')
    // capture again, then exit while captured: released and fully cleaned up
    await page.getByTestId('viewer3d-canvas').click()
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('locked')
    await page.getByTestId('walk-exit').click()
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('off')
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull()
    const after = await state3d(page)
    expect(after.walk.listeners).toBe(0)
    expect(after.walk.loopRunning).toBe(false)
    expect(after.camera).toEqual(orbitBefore.camera) // the orbit view is exactly as it was
    expect(after.target).toEqual(orbitBefore.target)
    await expect(page.getByTestId('nav-orbit')).toHaveAttribute('aria-pressed', 'true')
    // orbit still works
    const box = (await page.getByTestId('viewer3d-canvas').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 30, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await state3d(page)).camera).not.toEqual(orbitBefore.camera)
  })

  test('is fully keyboard-operable: enter with Enter, move and turn with keys, leave with Enter', async ({ page }) => {
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    await page.getByTestId('nav-walk').focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('ready')
    await expect(page.getByTestId('viewer3d-canvas')).toBeFocused() // keys work immediately, no mouse needed
    const before = await pos(page)
    const moved = await walkFor(page, ['KeyW'], 500)
    expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeGreaterThan(30)
    const turned = await walkFor(page, ['ArrowRight'], 300)
    expect(turned.h).not.toBeCloseTo(moved.h, 0)
    await page.getByTestId('walk-exit').focus()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('off')
  })

  test('shift walks faster, and speed does not depend on how long a frame takes', async ({ page }) => {
    await openWalk(page)
    expect(await place(page, 200, 300, 0)).toBe(true)
    const slow = await walkFor(page, ['KeyW'], 600)
    expect(await place(page, 200, 300, 0)).toBe(true)
    const fast = await walkFor(page, ['ShiftLeft', 'KeyW'], 600)
    expect(fast.x - 200).toBeGreaterThan((slow.x - 200) * 1.3)
    expect(slow.x - 200).toBeGreaterThan(40)
  })

  test('switching floors puts the walker at a fresh safe spot on that floor at that floor\'s eye height', async ({ page }) => {
    await openWalk(page, 'First floor', WALLS.north)
    expect((await state3d(page)).walk.eyeCm).toBe(410)
    await page.locator('select').first().selectOption({ label: 'Ground floor' })
    await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.studioWest })
    await expect.poll(async () => (await debug3d(page))?.walk.eyeCm).toBe(160)
    await expect.poll(async () => (await state3d(page)).camera[1]).toBeCloseTo(1.6, 3)
    const d = await state3d(page)
    expect(d.walk.start).toMatchObject({ ok: true })
    expect(d.walk.phase).not.toBe('off')
    // the upper floors do not obstruct the view
    expect(d.groups.map((g) => g.visible)).toEqual([true, false, false])
  })

  test('is read-only: no FloorGen writes, and the artwork and its unsaved status are untouched', async ({ page }) => {
    const { writes } = trackWrites(page)
    await openWall(page, 'First floor', WALLS.north)
    await page.getByLabel('Horizontal position').fill('450')
    const status = page.getByTestId('save-status')
    const before = { state: await status.getAttribute('data-state'), u: await page.getByLabel('Horizontal position').inputValue(), w: await page.getByLabel('Width').inputValue() }
    expect(['new', 'unsaved']).toContain(before.state)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    const art = (await state3d(page)).artwork
    await page.getByTestId('nav-walk').click()
    await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
    await walkFor(page, ['KeyW'], 600)
    await walkFor(page, ['ArrowLeft'], 300)
    await page.getByTestId('walk-exit').click()
    expect((await state3d(page)).artwork).toEqual(art)
    await to2d(page)
    expect({ state: await status.getAttribute('data-state'), u: await page.getByLabel('Horizontal position').inputValue(), w: await page.getByLabel('Width').inputValue() }).toEqual(before)
    expect(writes).toEqual([])
  })

  test('toggling 2D, Orbit and Walk repeatedly leaves no listeners, loops or canvases behind', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))
    await openWall(page, 'First floor', WALLS.north)
    await to3d(page)
    await importModel(page, mockTownhouse({ x1Cm: 800 }))
    await ready3d(page)
    for (let i = 0; i < 6; i++) {
      await page.getByTestId('nav-walk').click()
      await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
      const on = (await state3d(page)).walk
      expect(on.listeners).toBeGreaterThan(0)
      expect(on.listeners).toBeLessThanOrEqual(6) // keydown, keyup, blur, mousemove, pointerlockchange, click
      await walkFor(page, ['KeyW'], 120)
      await page.getByTestId('nav-orbit').click()
      await expect.poll(async () => (await state3d(page)).walk.listeners).toBe(0)
      if (i % 2) {
        await to2d(page)
        await to3d(page)
        await ready3d(page)
        expect(await page.locator('canvas').count()).toBe(1)
      }
    }
    // walk and leave straight through 2D (the whole panel unmounts while walking)
    await page.getByTestId('nav-walk').click()
    await expect.poll(async () => (await state3d(page)).walk.phase).toBe('ready')
    await to2d(page)
    expect(await page.locator('canvas').count()).toBe(0)
    await to3d(page)
    await ready3d(page)
    const idle = await state3d(page)
    expect(idle.walk).toMatchObject({ phase: 'off', listeners: 0, loopRunning: false })
    // an idle walker does not render continuously
    await page.getByTestId('nav-walk').click()
    await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
    await page.waitForTimeout(800)
    const r = (await state3d(page)).renderCount
    await page.waitForTimeout(500)
    expect((await state3d(page))).toMatchObject({ renderCount: r, walk: { loopRunning: false } })
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([])
  })

  test('narrow screens: the Walk controls fit and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWalk(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByTestId('walk-exit')).toBeVisible()
    await expect(page.getByTestId('walk-status')).toBeVisible()
  })

  test('when the browser refuses to capture the mouse, Walk says so and keeps working from the keyboard', async ({ page }) => {
    await openWalk(page) // headless Chromium really does refuse pointer lock
    await page.getByTestId('viewer3d-canvas').click()
    await expect(page.getByTestId('walk-status')).toContainText('would not capture the mouse')
    expect((await state3d(page)).walk.phase).toBe('ready')
    const before = await pos(page)
    const after = await walkFor(page, ['KeyW'], 400)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(20)
  })
})
