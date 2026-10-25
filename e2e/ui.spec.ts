import { expect, test, type Page } from '@playwright/test'

// Mutating tests use their own wall (east) because Playwright workers share one mock server.
const pickWall = async (page: Page, wall: string) => {
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: `Room A — ${wall}` })
  await expect(page.getByTestId('artwork')).toBeVisible()
}
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)
const status = (page: Page) => page.getByTestId('save-status')

// ---- contrast helper: WCAG ratio from computed rgb() strings ----
const lum = ([r, g, b]: number[]) => {
  const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test.describe('themes', () => {
  test('System follows the OS and reacts to OS changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    expect(await theme(page)).toBe('dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => theme(page)).toBe('light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => theme(page)).toBe('dark')
    await expect(page.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('an explicit choice overrides the OS and persists across reloads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await page.getByRole('button', { name: 'Light' }).click()
    expect(await theme(page)).toBe('light')
    await page.reload()
    expect(await theme(page)).toBe('light')
    expect(await page.evaluate(() => localStorage.getItem('wallsnap.theme'))).toBe('light')
    // OS changes are ignored while explicit.
    await page.emulateMedia({ colorScheme: 'light' })
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await theme(page)).toBe('light')
    await page.getByRole('button', { name: 'System' }).click()
    expect(await theme(page)).toBe('dark')
    expect(await page.evaluate(() => localStorage.getItem('wallsnap.theme'))).toBe('system')
  })

  test('works when storage is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked') } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Dark' }).click()
    expect(await theme(page)).toBe('dark')
  })

  test('the artwork keeps its own colour in every theme', async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
    const fill = () => page.getByTestId('artwork').evaluate((el) => getComputedStyle(el).fill)
    await page.getByRole('button', { name: 'Light' }).click()
    const light = await fill()
    await page.getByRole('button', { name: 'Dark' }).click()
    expect(await fill()).toBe(light)
    expect(light).toBe('rgb(75, 90, 112)')
  })

  for (const mode of ['Light', 'Dark']) {
    test(`${mode}: key text meets contrast 4.5:1 and keyboard focus is visible`, async ({ page }) => {
      await page.route('**/api/status', async (route) => {
        const res = await route.fetch() // present the status of a live DEV session so the 3D link is rendered
        await route.fulfill({ response: res, json: { ...(await res.json()), viewer3dUrl: 'https://floorgen.app/projects#/p/p_1ii0qmfr58hv4/3d' } })
      })
      await page.goto('/')
      await page.getByRole('button', { name: mode }).click()
      await pickWall(page, 'north wall, 600 cm')
      // Effective background: composite translucent layers up the tree over the first opaque one.
      const colours = (sel: string) =>
        page.locator(sel).first().evaluate((el) => {
          const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
          const layers: number[][] = []
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor)
            const a = c.length === 4 ? c[3] : 1
            if (a > 0) layers.push([c[0], c[1], c[2], a])
            if (a === 1) break
          }
          let [r, g, b] = [255, 255, 255]
          for (const l of layers.reverse()) [r, g, b] = [l[0] * l[3] + r * (1 - l[3]), l[1] * l[3] + g * (1 - l[3]), l[2] * l[3] + b * (1 - l[3])]
          return { fg: getComputedStyle(el).color, bg: `rgb(${r}, ${g}, ${b})` }
        })
      for (const sel of [
        'body', 'form label span', 'form input', 'button[type=submit]', 'a[href]', 'header select',
        '[aria-pressed=true]', '[aria-pressed=false]', 'form p', 'legend',
      ]) {
        const c = await colours(sel)
        expect(ratio(c.fg, c.bg), `${sel} ${c.fg} on ${c.bg}`).toBeGreaterThanOrEqual(4.5)
      }
      // Visible keyboard focus on an input and on the artwork.
      await page.getByLabel('Width').focus()
      expect(await page.getByLabel('Width').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
      await page.getByTestId('artwork').focus()
      expect(await page.getByTestId('artwork').evaluate((el) => getComputedStyle(el).strokeWidth)).toBe('2px')
    })
  }
})

test.describe('workspace layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'north wall, 600 cm')
  })

  test('desktop: full-height app, fixed-width inspector on the right, dimensions shown', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const insp = (await page.locator('form').boundingBox())!
    expect(insp.width).toBeCloseTo(320, 0)
    expect(insp.x + insp.width).toBeCloseTo(1280, 0)
    const stage = (await page.getByTestId('elevation').boundingBox())!
    expect(stage.x + stage.width).toBeLessThan(insp.x)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true)
    await expect(page.getByText('Wall: 600 × 250 cm')).toBeVisible()
    await expect(page.getByText('Endpoint A is at the left')).toBeVisible()
    await expect(page.getByTestId('elevation').getByText('A → B')).toBeVisible()
  })

  test('narrow: inspector stacks beneath the editor and everything stays reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    const stage = (await page.getByTestId('elevation').boundingBox())!
    const insp = (await page.locator('form').boundingBox())!
    expect(insp.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    for (const name of ['Width', 'Height', 'Horizontal position', 'Bottom elevation']) {
      await page.getByLabel(name).scrollIntoViewIfNeeded()
      await expect(page.getByLabel(name)).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeVisible()
  })

  test('the wall keeps its proportions at any window size', async ({ page }) => {
    const wallRect = page.locator('[data-testid=elevation] > rect').first()
    for (const [w, h] of [[1280, 800], [900, 700], [390, 800], [1600, 600]]) {
      await page.setViewportSize({ width: w, height: h })
      const b = (await wallRect.boundingBox())!
      expect(b.width / b.height, `${w}x${h}`).toBeCloseTo(600 / 250, 1)
    }
  })

  test('dragging stays accurate in wall centimetres after the window is resized', async ({ page }) => {
    const centre = page.getByLabel('Horizontal position')
    for (const [w, h] of [[1280, 800], [1000, 700], [420, 800]]) {
      await page.setViewportSize({ width: w, height: h })
      await page.getByLabel('Horizontal position').fill('200')
      const rect = page.getByTestId('artwork')
      const box = (await rect.boundingBox())!
      const wallBox = (await page.locator('[data-testid=elevation] > rect').first().boundingBox())!
      const pxPerCm = wallBox.width / 600
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 50, y, { steps: 4 })
      await page.mouse.up()
      const moved = Number(await centre.inputValue()) - 200
      expect(moved * pxPerCm, `${w}x${h}`).toBeCloseTo(50, 0)
    }
  })
})

test('a live size readout appears only while resizing and matches the inputs', async ({ page }) => {
  await page.goto('/')
  await pickWall(page, 'north wall, 600 cm')
  await expect(page.getByTestId('size-readout')).toHaveCount(0)
  const box = (await page.getByTestId('hit-se').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 15, { steps: 4 })
  const w = await page.getByLabel('Width').inputValue()
  const h = await page.getByLabel('Height').inputValue()
  await expect(page.getByTestId('size-readout')).toHaveText(`${w} × ${h} cm`)
  await page.mouse.up()
  await expect(page.getByTestId('size-readout')).toHaveCount(0)
})

test('numeric controls are keyboard reachable in order and the nudge hint is shown', async ({ page }) => {
  await page.goto('/')
  await pickWall(page, 'north wall, 600 cm')
  await expect(page.getByText(/nudge 1 cm/)).toBeVisible()
  await expect(page.getByText(/measured from endpoint A/)).toBeVisible()
  await page.getByLabel('Width').focus()
  for (const next of ['Height', 'Horizontal position', 'Bottom elevation']) {
    await page.keyboard.press('Tab')
    await expect(page.getByLabel(next)).toBeFocused()
  }
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeFocused()
})

test.describe('save states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await pickWall(page, 'east wall, 400 cm')
  })

  test('new → invalid → verified → unsaved → verified', async ({ page }) => {
    await expect(status(page)).toHaveAttribute('data-state', 'new')
    await page.getByLabel('Height').fill('250')
    await expect(status(page)).toHaveAttribute('data-state', 'invalid')
    await expect(page.getByTestId('status-card')).toContainText('Height cannot exceed 200 cm.')
    await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeDisabled()
    await page.getByLabel('Height').fill('45')
    await expect(status(page)).toHaveAttribute('data-state', 'new')

    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
    await expect(status(page)).toContainText('Saved · verified')
    await expect(page.getByTestId('message')).toContainText('Verified in FloorGen')

    await page.getByLabel('Horizontal position').fill('150')
    await expect(status(page)).toHaveAttribute('data-state', 'unsaved')
    await expect(page.getByTestId('message')).not.toContainText('Verified')

    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
  })

  test('saving is shown while the request is in flight, and success never appears before the reply', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await page.route('**/api/artwork', async (route) => {
      await gate
      await route.continue()
    })
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'saving')
    await expect(page.getByTestId('message')).not.toContainText('Verified')
    release()
    await expect(status(page)).toHaveAttribute('data-state', 'verified')
  })

  test('revision conflict is distinct, blocks Apply and recovers through Reload', async ({ page }) => {
    await page.route('**/api/artwork', (r) =>
      r.fulfill({ status: 409, json: { error: 'The FloorGen project changed since you loaded this wall. Reload before applying.', code: 'stale' } }),
    )
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'conflict')
    await expect(page.getByTestId('status-card')).toContainText('project changed')
    await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeDisabled()
    await page.unroute('**/api/artwork')
    await page.getByRole('button', { name: 'Reload from FloorGen' }).click()
    await expect(status(page)).not.toHaveAttribute('data-state', 'conflict')
    await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeEnabled()
  })

  test('a partial save describes what FloorGen actually holds', async ({ page }) => {
    const msg = 'Partially saved: it was resized to 90×50 cm, but moving it to the requested position failed (nope). Reload to see the actual state; FloorGen holds the changes below.'
    await page.route('**/api/artwork', (r) => r.fulfill({ status: 502, json: { error: msg, code: 'partial' } }))
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'partial')
    await expect(page.getByTestId('status-card')).toContainText('resized to 90×50 cm')
    await expect(page.getByRole('button', { name: 'Reload from FloorGen' })).toBeVisible()
  })

  test('a FloorGen rejection shows its message, then clears on the next edit', async ({ page }) => {
    await page.route('**/api/artwork', (r) =>
      r.fulfill({ status: 422, json: { error: 'FloorGen rejected the placement: The item is too tall.', code: 'VALIDATION_FAILED' } }),
    )
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'error')
    await expect(page.getByTestId('status-card')).toContainText('The item is too tall.')
    await page.getByLabel('Horizontal position').fill('120')
    await expect(status(page)).not.toHaveAttribute('data-state', 'error')
  })
})
