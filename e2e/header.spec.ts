import { expect, test, type Page } from '@playwright/test'

// The header's Floor and Wall pickers must have stable, text-independent sizes: no layout shift when FloorGen data arrives,
// and long names truncate instead of widening the controls or pushing the status pill / theme control out.

const WIDTHS = [1440, 1100, 901, 900, 768, 390, 320]
const LONG = 'The Extraordinarily Long Floor Name — Living / Dining / Kitchen / Pantry / Conservatory Annexe'

interface Box { x: number; y: number; width: number; height: number }
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5

/** Geometry of everything in the header that must not move. */
async function measure(page: Page) {
  const box = async (loc: ReturnType<Page['locator']>): Promise<Box> => (await loc.boundingBox())!
  const selects = page.locator('header select')
  return {
    header: await box(page.locator('header')),
    floor: await box(selects.nth(0)),
    wall: await box(selects.nth(1)),
    status: await box(page.getByTestId('save-status')),
    // The segmented theme control on wide screens, the settings button on narrow ones.
    theme: await box(page.locator('header [aria-label="Theme"]:visible, header [aria-label="Settings"]:visible').first()),
  }
}

/** Holds the floors request back so the header can be measured while it is still empty. */
async function loadWithGate(page: Page, mutate?: (floors: { name: string; walls: { label: string }[] }[]) => unknown) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await page.route('**/api/floors', async (route) => {
    await gate
    if (!mutate) return route.continue()
    const res = await route.fetch()
    await route.fulfill({ response: res, json: mutate(await res.json()) })
  })
  await page.goto('/')
  await expect(page.locator('header select').first()).toBeVisible() // rendered immediately, before any data
  return { release, before: await measure(page) }
}

const sameLayout = (a: Awaited<ReturnType<typeof measure>>, b: Awaited<ReturnType<typeof measure>>, label: string) => {
  expect(near(a.header.height, b.header.height), `${label}: header height ${a.header.height} vs ${b.header.height}`).toBe(true)
  for (const k of ['floor', 'wall'] as const) {
    for (const d of ['x', 'y', 'width', 'height'] as const) {
      expect(near(a[k][d], b[k][d]), `${label}: ${k}.${d} ${a[k][d]} vs ${b[k][d]}`).toBe(true)
    }
  }
  for (const d of ['x', 'y', 'width', 'height'] as const) {
    expect(near(a.theme[d], b.theme[d]), `${label}: theme.${d} ${a.theme[d]} vs ${b.theme[d]}`).toBe(true)
  }
  // The pill's text (and so its width) may change with the state, but it stays right-aligned in the same place.
  expect(near(a.status.x + a.status.width, b.status.x + b.status.width), `${label}: status right edge`).toBe(true)
  expect(near(a.status.y, b.status.y), `${label}: status y`).toBe(true)
}

const inside = (m: Awaited<ReturnType<typeof measure>>, width: number, label: string) => {
  for (const k of ['floor', 'wall', 'status', 'theme'] as const) {
    expect(m[k].x, `${label}: ${k} left`).toBeGreaterThanOrEqual(-0.5)
    expect(m[k].x + m[k].width, `${label}: ${k} right edge ${m[k].x + m[k].width} > ${width}`).toBeLessThanOrEqual(width + 0.5)
  }
}

test.describe('no layout shift when FloorGen data arrives', () => {
  for (const width of WIDTHS) {
    test(`${width}px: the header is identical before and after floors load, and after a wall is chosen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      const { release, before } = await loadWithGate(page)
      release()
      await expect(page.locator('header select').first().locator('option')).not.toHaveCount(0) // floors arrived
      const after = await measure(page)
      sameLayout(before, after, 'after floors')
      await page.getByLabel('Floor').selectOption({ label: 'First floor' })
      await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
      await expect(page.getByTestId('artwork')).toBeVisible()
      sameLayout(before, await measure(page), 'after a wall is chosen')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
})

test.describe('stable, text-independent widths', () => {
  for (const width of WIDTHS) {
    test(`${width}px: very long floor and wall names change nothing and stay inside the header`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      // Short names first (the reference), in a clean page.
      await page.goto('/')
      await page.getByLabel('Floor').selectOption({ label: 'First floor' })
      await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
      await expect(page.getByTestId('artwork')).toBeVisible()
      const short = await measure(page)

      const long = await page.context().newPage()
      await long.setViewportSize({ width, height: 800 })
      await long.route('**/api/floors', async (route) => {
        const res = await route.fetch()
        const floors = (await res.json()) as { name: string; walls: { label: string }[] }[]
        await route.fulfill({
          response: res,
          json: floors.map((f) => ({ ...f, name: `${LONG} (${f.name})`, walls: f.walls.map((w) => ({ ...w, label: `${LONG} — ${w.label}` })) })),
        })
      })
      await long.goto('/')
      await long.locator('header select').first().selectOption({ index: 1 })
      await long.locator('header select').nth(1).selectOption({ index: 1 })
      await expect(long.getByTestId('artwork')).toBeVisible()
      const withLong = await measure(long)

      sameLayout(short, withLong, 'long vs short names')
      inside(withLong, width, 'long names')
      expect(await long.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      // The selects clip with an ellipsis rather than growing; the full name stays available.
      for (const i of [0, 1]) {
        const s = long.locator('header select').nth(i)
        expect(await s.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis')
        await expect(s).toHaveAttribute('title', /Extraordinarily Long/)
      }
    })
  }
})

test('the pickers keep their size in the empty and error states too', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/')
  await expect(page.locator('header select').first().locator('option')).not.toHaveCount(0)
  const normal = await measure(page)

  const broken = await page.context().newPage()
  await broken.setViewportSize({ width: 1440, height: 800 })
  await broken.route('**/api/floors', (r) => r.fulfill({ status: 502, json: { error: 'FloorGen is unreachable' } }))
  await broken.goto('/')
  await expect(broken.getByTestId('status-card')).toBeVisible().catch(() => undefined)
  await expect(broken.locator('header select').first()).toBeVisible()
  await expect(broken.getByTestId('save-status')).toHaveAttribute('data-state', /error|none/)
  const err = await measure(broken)
  expect(err.floor.width).toBeCloseTo(normal.floor.width, 0)
  expect(err.wall.width).toBeCloseTo(normal.wall.width, 0)
  expect(err.floor.x).toBeCloseTo(normal.floor.x, 0)
  expect(err.wall.x).toBeCloseTo(normal.wall.x, 0)
  expect(err.header.height).toBeCloseTo(normal.header.height, 0)
})

test('desktop widths are explicit and independent of option text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/')
  const m = await measure(page)
  expect(m.floor.width).toBeGreaterThan(150)
  expect(m.wall.width).toBeGreaterThan(m.floor.width) // the wall names are the longer ones
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
  const m2 = await measure(page)
  expect(near(m.floor.width, m2.floor.width) && near(m.wall.width, m2.wall.width)).toBe(true)
})
