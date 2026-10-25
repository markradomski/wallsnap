import { expect, test, type Page } from '@playwright/test'

const num = async (page: Page, label: string) => Number(await page.getByLabel(label).inputValue())
const read = async (page: Page) => ({
  width: await num(page, 'Width'),
  height: await num(page, 'Height'),
  u: await num(page, 'Horizontal position'),
  v: await num(page, 'Bottom elevation'),
})
const edges = (a: { width: number; height: number; u: number; v: number }) => ({
  u0: a.u - a.width / 2, u1: a.u + a.width / 2, v0: a.v, v1: a.v + a.height,
})

async function drag(page: Page, testId: string, dx: number, dy: number) {
  const box = (await page.getByTestId(testId).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
  await expect(page.getByTestId('artwork')).toBeVisible()
})

test('eight handles with resize cursors', async ({ page }) => {
  const cursors: Record<string, string> = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
  }
  for (const [h, cursor] of Object.entries(cursors)) {
    await expect(page.getByTestId(`handle-${h}`)).toBeVisible()
    expect(await page.getByTestId(`hit-${h}`).evaluate((el) => getComputedStyle(el).cursor)).toBe(cursor)
  }
  // Hit targets are larger than the visible handle square.
  const hit = (await page.getByTestId('hit-e').boundingBox())!
  const vis = (await page.getByTestId('handle-e').locator('rect').first().boundingBox())!
  expect(hit.width).toBeGreaterThan(vis.width * 2)
})

test('edge and corner resizing keep the opposite side anchored and stay local', async ({ page }) => {
  const puts: string[] = []
  page.on('request', (r) => r.method() === 'PUT' && puts.push(r.url()))
  const start = await read(page)
  const s = edges(start)

  await drag(page, 'hit-e', 60, 0)
  let now = await read(page)
  expect(now.width).toBeGreaterThan(start.width + 20)
  expect(edges(now).u0).toBeCloseTo(s.u0, 0) // west edge anchored
  expect([now.height, now.v]).toEqual([start.height, start.v])

  await drag(page, 'hit-nw', -40, -30)
  const afterEdge = now
  now = await read(page)
  expect(now.width).toBeGreaterThan(afterEdge.width)
  expect(now.height).toBeGreaterThan(afterEdge.height)
  expect(edges(now).u1).toBeCloseTo(edges(afterEdge).u1, 0) // east edge anchored
  expect(edges(now).v0).toBeCloseTo(edges(afterEdge).v0, 0) // bottom anchored

  expect(puts).toEqual([]) // nothing is written to FloorGen while dragging
})

test('resizing is clamped to the wall and the 200 cm limit', async ({ page }) => {
  await drag(page, 'hit-w', -2000, 0)
  let a = await read(page)
  expect(edges(a).u0).toBeCloseTo(0, 0)

  await drag(page, 'hit-s', 0, 2000)
  a = await read(page)
  expect(a.v).toBe(0)
  expect(a.height).toBeLessThanOrEqual(200)

  await drag(page, 'hit-n', 0, -2000)
  a = await read(page)
  expect(a.height).toBe(200)
  expect(a.v + a.height).toBeLessThanOrEqual(250)
})

test('an edge cannot cross its anchor', async ({ page }) => {
  await drag(page, 'hit-e', -2000, 0)
  const a = await read(page)
  expect(a.width).toBeGreaterThanOrEqual(1)
  expect(a.width).toBeLessThan(2)
})

test('dragging inside the rectangle still moves without resizing', async ({ page }) => {
  const start = await read(page)
  const box = (await page.getByTestId('artwork').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  const now = await read(page)
  expect(now.u).toBeGreaterThan(start.u + 20)
  expect([now.width, now.height]).toEqual([start.width, start.height])
})

test('SVG and numeric controls stay in sync both ways', async ({ page }) => {
  const rect = page.getByTestId('artwork')
  await drag(page, 'hit-se', 40, 20)
  const a = await read(page)
  expect(Number(await rect.getAttribute('width'))).toBeCloseTo(a.width, 0)
  expect(Number(await rect.getAttribute('height'))).toBeCloseTo(a.height, 0)

  await page.getByLabel('Width').fill('120')
  await page.getByLabel('Height').fill('80')
  expect(Number(await rect.getAttribute('width'))).toBe(120)
  expect(Number(await rect.getAttribute('height'))).toBe(80)
  // Handles follow the typed size: the east handle sits on the rectangle's east edge.
  const r = (await rect.boundingBox())!
  const h = (await page.getByTestId('hit-e').boundingBox())!
  expect(Math.abs(h.x + h.width / 2 - (r.x + r.width))).toBeLessThan(2) // bounding box includes the stroke
})

test('a success message is cleared once the artwork is edited again', async ({ page }) => {
  // Applies, so it uses its own wall (west): workers share one mock server.
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — west wall, 400 cm' })
  await expect(page.getByTestId('artwork')).toBeVisible()
  await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
  await expect(page.getByTestId('message')).toContainText('Verified in FloorGen')
  await drag(page, 'hit-e', 30, 0)
  await expect(page.getByTestId('message')).not.toContainText('Verified')
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'unsaved')
})
