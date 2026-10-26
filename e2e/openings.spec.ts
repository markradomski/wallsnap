import { expect, test, type Page } from '@playwright/test'

// Mock walls (FloorGen opening data, wall 250 cm high):
//   Room A north (A west, 600): window  u 140..260, sill 90, height 120
//   Room A south (A east, 600): door u 105..195 (sill 0, height 205) and a small window u 490..550 (sill 100, height 100); stored in the opposite direction
//   Room A east  (400): a doorway u 295..385, sill 0, height 205
//   Room A west  (400): none
const open = async (page: Page, wall: string) => {
  await page.goto('/')
  await page.locator('header select').first().selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: `Room A — ${wall}` })
  await expect(page.getByTestId('elevation')).toBeVisible()
}
const rects = (page: Page) =>
  page.getByTestId('opening').evaluateAll((gs) =>
    gs.map((g) => {
      const r = g.querySelector('rect')!
      return {
        kind: g.getAttribute('data-kind'), x: +r.getAttribute('x')!, y: +r.getAttribute('y')!, w: +r.getAttribute('width')!, h: +r.getAttribute('height')!,
        label: g.querySelector('text')?.textContent ?? null,
      }
    }),
  )
const api = async (page: Page, floor: string, wall: string) =>
  ((await (await page.request.get(`/api/wall?floor=${floor}&wall=${wall}`)).json()) as { wall: { height: number; openings: { left: number; width: number; sill: number; height: number; kind: string }[] } }).wall

test('a large window is drawn above its sill, not as a full-height strip', async ({ page }) => {
  await open(page, 'north wall, 600 cm')
  const [w] = await rects(page)
  const real = (await api(page, 'f_first', 'fl_north')).openings[0]
  expect(real).toMatchObject({ left: 140, width: 120, sill: 90, height: 120 })
  expect(w).toMatchObject({ kind: 'window', x: 140, y: 250 - 90 - 120, w: 120, h: 120, label: 'Window' })
  expect(w.h).toBeLessThan(250)
})

test('a door on a wall stored in the opposite direction is measured from endpoint A and reaches the floor', async ({ page }) => {
  await open(page, 'south wall, 600 cm')
  const [d] = await rects(page)
  const real = (await api(page, 'f_first', 'fl_south')).openings[0]
  expect(real.left).toBe(105)
  expect(d).toMatchObject({ kind: 'door', x: 105, y: 250 - 205, w: 90, h: 205, label: 'Door' })
  expect(d.y + d.h).toBe(250) // starts at the floor
})

test('a wall with several openings shows each at its own place and size', async ({ page }) => {
  await open(page, 'south wall, 600 cm')
  const all = await rects(page)
  expect(all).toHaveLength(2)
  const door = all.find((o) => o.kind === 'door')!
  const win = all.find((o) => o.kind === 'window')!
  expect(door).toMatchObject({ x: 105, y: 250 - 205, w: 90, h: 205, label: 'Door' })
  expect(win).toMatchObject({ x: 490, y: 250 - 100 - 100, w: 60, h: 100, label: 'Window' })
  expect(win.y + win.h).toBeLessThan(250 - 90) // above its sill
})

test('a wall with none draws none', async ({ page }) => {
  await open(page, 'west wall, 400 cm')
  expect(await rects(page)).toEqual([])
})

test('openings sit behind the artwork, which stays draggable and resizable over them; Apply is blocked while they overlap', async ({ page }) => {
  await open(page, 'north wall, 600 cm')
  await page.getByLabel('Horizontal position').fill('200')
  await page.getByLabel('Bottom elevation').fill('100')
  const apply = page.getByRole('button', { name: /^Apply all changes/ })
  await expect(page.getByTestId('opening')).toHaveAttribute('data-conflict', 'true')
  await expect(page.getByTestId('opening-conflict')).toHaveCount(1)
  await expect(apply).toBeDisabled()
  await expect(page.getByRole('alert').or(page.getByText('overlaps a door or window')).first()).toBeVisible()
  // stacking: the artwork receives the pointer at its centre, and the hatched overlay is above it but does not take events
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector('[data-testid=elevation]')!.children]
    const idx = (sel: string) => kids.findIndex((k) => k.matches(sel) || k.querySelector(sel))
    return { opening: idx('[data-testid=opening]'), art: idx('[data-testid=artwork]'), conflict: idx('[data-testid=opening-conflict]') }
  })
  expect(order.opening).toBeLessThan(order.art)
  expect(order.conflict).toBeGreaterThan(order.art)
  const box = (await page.getByTestId('artwork').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as Element).getAttribute('data-testid'), [cx, cy])).toBe('artwork')
  // drag it clear of the window, over the opening graphics: it follows the pointer
  const before = Number(await page.getByLabel('Horizontal position').inputValue())
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 120, cy, { steps: 6 })
  await page.mouse.up()
  expect(Number(await page.getByLabel('Horizontal position').inputValue())).toBeGreaterThan(before + 20)
  // resize by a handle while it still overlaps
  await page.getByLabel('Horizontal position').fill('200')
  const w0 = Number(await page.getByLabel('Width').inputValue())
  const h = (await page.getByTestId('hit-e').boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 + 25, h.y + h.height / 2, { steps: 4 })
  await page.mouse.up()
  expect(Number(await page.getByLabel('Width').inputValue())).toBeGreaterThan(w0)
  await expect(apply).toBeDisabled()
  // clear of the window: conflict gone, Apply allowed
  await page.getByLabel('Horizontal position').fill('450')
  await expect(page.getByTestId('opening')).toHaveAttribute('data-conflict', 'false')
  await expect(page.getByTestId('opening-conflict')).toHaveCount(0)
  await expect(apply).toBeEnabled()
})
