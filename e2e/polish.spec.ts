import { expect, test, type Page } from '@playwright/test'

// Mutating tests use the west/east walls of Room A; workers share one mock server (see ui.spec.ts).
const pickWall = async (page: Page, wall: string) => {
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: `Room A — ${wall}` })
  await expect(page.getByTestId('artwork')).toBeVisible()
}
const status = (page: Page) => page.getByTestId('save-status')
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)

type Box = { x: number; y: number; width: number; height: number }
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

const lum = ([r, g, b]: number[]) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test.describe('1. compact mobile header', () => {
  test('the editor starts high on a phone and the theme lives in a settings menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
    const header = (await page.locator('header').boundingBox())!
    expect(header.height).toBeLessThanOrEqual(90)
    const stage = (await page.getByTestId('elevation').boundingBox())!
    expect(stage.y).toBeLessThan(220)
    // Identity, selection and status stay visible.
    await expect(page.getByRole('heading', { name: 'WallSnap' })).toBeVisible()
    await expect(page.getByLabel('Floor')).toBeVisible()
    await expect(page.getByRole('combobox').nth(1)).toBeVisible()
    await expect(status(page)).toBeVisible()
    // The segmented theme control is gone; the menu has it.
    await expect(page.getByRole('button', { name: 'Light' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Dark' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused()
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Dark' }).click()
    expect(await theme(page)).toBe('dark')
    await expect(page.getByRole('button', { name: 'Dark' })).toHaveCount(0) // closes after choosing
  })

  test('the menu closes on an outside click', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('heading', { name: 'WallSnap' }).click()
    await expect(page.getByRole('button', { name: 'System' })).toHaveCount(0)
  })

  test('the full header returns on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Light' })).toBeVisible()
  })

  for (const width of [390, 320, 768]) {
    test(`very long floor and wall names never overflow at ${width}px, and the selected wall stays identifiable`, async ({ page }) => {
      const long = 'The Extraordinarily Long Floor Name — Living / Dining / Kitchen / Pantry / Conservatory Annexe'
      await page.route('**/api/floors', async (route) => {
        const res = await route.fetch()
        const floors = (await res.json()) as { name: string; walls: { label: string }[] }[]
        await route.fulfill({
          response: res,
          json: floors.map((f) => ({ ...f, name: `${long} (${f.name})`, walls: f.walls.map((w) => ({ ...w, label: `${long} — ${w.label}` })) })),
        })
      })
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/')
      const floorSelect = page.getByRole('combobox').first()
      await floorSelect.selectOption({ index: 1 })
      const wallSelect = page.getByRole('combobox').nth(1)
      await wallSelect.selectOption({ index: 1 })
      await expect(page.getByTestId('artwork')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      for (const sel of [floorSelect, wallSelect]) {
        const b = (await sel.boundingBox())!
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(width)
      }
      // The full name remains reachable: tooltip on the select and a truncating line above the drawing.
      const name = page.getByTestId('wall-name')
      await expect(name).toContainText('Extraordinarily Long')
      await expect(name).toHaveAttribute('title', /Extraordinarily Long/)
      await expect(wallSelect).toHaveAttribute('title', /Extraordinarily Long/)
      const nb = (await name.boundingBox())!
      expect(nb.x + nb.width).toBeLessThanOrEqual(width)
    })
  }
})

test.describe('2. concise save confirmation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'west wall, 400 cm') // own wall: workers share one mock server
  })

  test('a verified save is a small collapsed disclosure, not a second success panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
    await expect(page.getByTestId('status-card')).toHaveCount(0) // no big panel
    const details = page.locator('details')
    await expect(details).toBeVisible()
    expect(await details.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false)
    await expect(page.getByTestId('message')).toBeHidden()
    const box = (await details.boundingBox())!
    expect(box.height).toBeLessThan(40)
    await details.locator('summary').click()
    await expect(page.getByTestId('message')).toContainText('Verified in FloorGen')
    await expect(page.getByTestId('message')).toContainText('revision')
  })

  test('verified clears as soon as local changes begin', async ({ page }) => {
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
    await page.getByLabel('Bottom elevation').fill('150')
    await expect(status(page)).toHaveAttribute('data-state', 'unsaved')
    await expect(page.locator('details')).toHaveCount(0)
    await expect(page.getByTestId('status-note')).toContainText('local')
  })

  test('failures stay prominent: an alert card, never a quiet note', async ({ page }) => {
    await page.route('**/api/artwork', (r) => r.fulfill({ status: 422, json: { error: 'FloorGen rejected the placement: nope', code: 'VALIDATION_FAILED' } }))
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    const card = page.getByTestId('status-card')
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('role', 'alert')
    await expect(card).toContainText('nope')
    await expect(page.locator('details')).toHaveCount(0)
  })

  test('verified is never shown before the reply arrives', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await page.route('**/api/artwork', async (route) => {
      await gate
      await route.continue()
    })
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'saving')
    await expect(page.locator('details')).toHaveCount(0)
    release()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
  })
})

test.describe('3. contextual dimension label', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
  })

  const hits = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  const fill = async (page: Page, v: { w: string; h: string; u: string; b: string }) => {
    await page.getByLabel('Width').fill(v.w)
    await page.getByLabel('Height').fill(v.h)
    await page.getByLabel('Horizontal position').fill(v.u)
    await page.getByLabel('Bottom elevation').fill(v.b)
  }

  for (const [name, v] of Object.entries({
    'bottom-left corner of the wall': { w: '100', h: '60', u: '50', b: '0' },
    'bottom-right corner': { w: '100', h: '60', u: '550', b: '0' },
    'top-left corner': { w: '100', h: '60', u: '50', b: '190' },
    'top-right corner': { w: '100', h: '60', u: '550', b: '190' },
    'a very small artwork in the corner': { w: '1', h: '1', u: '0.5', b: '0' },
    'a very small artwork at the ceiling': { w: '2', h: '2', u: '599', b: '248' },
    'mid-wall': { w: '120', h: '80', u: '400', b: '100' },
  })) {
    test(`label is legible, inside the wall and clear of every handle target: ${name}`, async ({ page }) => {
      await fill(page, v)
      const label = page.getByTestId('dimension-label')
      await expect(label).toBeVisible()
      const wall = (await page.locator('[data-testid=elevation] > rect').first().boundingBox())!
      const lb = (await label.boundingBox())!
      expect(lb.x).toBeGreaterThanOrEqual(wall.x - 1)
      expect(lb.x + lb.width).toBeLessThanOrEqual(wall.x + wall.width + 1)
      expect(lb.y).toBeGreaterThanOrEqual(wall.y - 1)
      expect(lb.y + lb.height).toBeLessThanOrEqual(wall.y + wall.height + 1)
      expect(await label.getAttribute('data-placement')).not.toBe('inside')
      for (const h of hits) {
        expect(overlap(lb, (await page.getByTestId(`hit-${h}`).boundingBox())!), `overlaps hit-${h}`).toBe(false)
      }
      expect(overlap(lb, (await page.getByTestId('artwork').boundingBox())!)).toBe(false)
    })
  }

  test('a nearly wall-high artwork puts the label inside it, without blocking pointer targets', async ({ page }) => {
    await fill(page, { w: '120', h: '200', u: '300', b: '25' })
    const label = page.getByTestId('dimension-label')
    await expect(label).toHaveAttribute('data-placement', 'inside')
    expect(await label.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  })

  test('text stays the same on-screen size at different viewport sizes', async ({ page }) => {
    const textHeight = async () => (await page.getByTestId('dimension-label').locator('text').boundingBox())!.height
    const big = await textHeight()
    await page.setViewportSize({ width: 600, height: 800 })
    // The scale observer re-renders on the next frame after a resize, so wait for it to settle.
    await expect.poll(async () => Math.abs(big - (await textHeight())), { timeout: 3000 }).toBeLessThan(3)
    expect(big).toBeGreaterThan(8)
  })

  for (const mode of ['Light', 'Dark']) {
    test(`label text has enough contrast in ${mode}`, async ({ page }) => {
      await page.getByRole('button', { name: mode }).click()
      const c = await page.getByTestId('dimension-label').evaluate((g) => ({
        fg: getComputedStyle(g.querySelector('text')!).fill,
        bg: getComputedStyle(g.querySelector('rect')!).fill,
      }))
      expect(ratio(c.fg, c.bg)).toBeGreaterThanOrEqual(7)
    })
  }
})

test.describe('4. dark workspace separation', () => {
  const read = (page: Page) =>
    page.evaluate(() => {
      const svg = document.querySelector('[data-testid=elevation]')!
      const wall = getComputedStyle(svg.querySelector(':scope > rect')!)
      const art = getComputedStyle(document.querySelector('[data-testid=artwork]')!)
      const stage = getComputedStyle(document.body)
      return { wallFill: wall.fill, wallEdge: wall.stroke, artFill: art.fill, artEdge: art.stroke, bg: stage.backgroundColor }
    })

  test('wall, artwork and canvas are distinguishable; the artwork colour never changes', async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
    await page.getByRole('button', { name: 'Light' }).click()
    const light = await read(page)
    await page.getByRole('button', { name: 'Dark' }).click()
    const dark = await read(page)
    expect(dark.artFill).toBe(light.artFill)
    expect(dark.artFill).toBe('rgb(75, 90, 112)')
    expect(ratio(dark.wallFill, dark.bg), 'wall plane vs canvas').toBeGreaterThanOrEqual(1.3)
    expect(ratio(dark.artFill, dark.wallFill), 'artwork vs wall').toBeGreaterThanOrEqual(1.7)
    expect(ratio(dark.wallEdge, dark.bg), 'wall edge vs canvas').toBeGreaterThanOrEqual(3)
    expect(ratio(dark.artEdge, dark.wallFill), 'artwork edge vs wall').toBeGreaterThanOrEqual(3)
  })

  test('the purple selection outline and handles survive in dark', async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
    await page.getByRole('button', { name: 'Dark' }).click()
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    expect(accent).toBe('#a78bfa')
    const stroke = await page.getByTestId('artwork').evaluate((el) => getComputedStyle(el).stroke)
    expect(stroke).toBe('rgb(167, 139, 250)')
    await expect(page.getByTestId('handle-se')).toBeVisible()
  })
})

test('tablet width: stacked layout, no overflow, inspector reachable', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto('/')
  await pickWall(page, 'north wall, 600 cm')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const stage = (await page.getByTestId('elevation').boundingBox())!
  const insp = (await page.locator('form').boundingBox())!
  expect(insp.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1)
  // Regression: the stacked rows must not stretch to the viewport, leaving a blank band under the drawing.
  expect(insp.y - (stage.y + stage.height)).toBeLessThan(90)
  await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeVisible()
})

test('phone: the editor starts at the top and Apply stays within one short scroll', async ({ page }) => {
  // The artwork-image section adds controls, so the whole inspector no longer fits one 844 px screen. The drawing and the
  // numeric fields stay on the first screen; Apply is reachable a short scroll below.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await pickWall(page, 'north wall, 600 cm')
  const stage = (await page.getByTestId('elevation').boundingBox())!
  expect(stage.y).toBeLessThan(220)
  const apply = (await page.getByRole('button', { name: 'Apply to FloorGen' }).boundingBox())!
  expect(apply.y + apply.height).toBeLessThanOrEqual(844 * 1.25)
  await page.getByRole('button', { name: 'Apply to FloorGen' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeVisible()
})

test('loading a wall never flashes empty inputs or a spurious "invalid" state', async ({ page }) => {
  // Regression: input text used to be filled by a follow-up effect, so the first render after loading had empty inputs.
  await page.addInitScript(() => {
    const seen = new Set<string>()
    ;(window as unknown as { __seen: Set<string> }).__seen = seen
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid=save-status]')?.getAttribute('data-state')
      if (s) seen.add(s)
      document.querySelectorAll('form input[inputmode=decimal]').forEach((i) => !(i as HTMLInputElement).value && seen.add('empty-input'))
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  await page.goto('/')
  await pickWall(page, 'north wall, 600 cm')
  await page.getByLabel('Width').fill('80') // and an edit
  await page.getByTestId('hit-e').click({ force: true })
  const seen = await page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen])
  expect(seen).not.toContain('empty-input')
  expect(seen).not.toContain('invalid')
  expect(seen).toContain('new')
})
