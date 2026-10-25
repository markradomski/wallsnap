import { expect, test } from '@playwright/test'

const URL3D = 'https://floorgen.app/projects#/p/p_1ii0qmfr58hv4/3d'

test.beforeEach(async ({ page }) => {
  // The mock adapter has no 3D link; present the status a live DEV session would return.
  await page.route('**/api/status', async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), viewer3dUrl: URL3D } })
  })
  await page.goto('/')
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
  await expect(page.getByTestId('artwork')).toBeVisible()
})

test('Open in FloorGen 3D is a keyboard-reachable link that opens a new tab and keeps unsaved edits', async ({ page, context }) => {
  // Don't hit the real site from tests.
  await context.route('https://floorgen.app/**', (r) => r.fulfill({ body: '<title>FloorGen</title>', contentType: 'text/html' }))

  const link = page.getByRole('link', { name: /Open in FloorGen 3D/ })
  await expect(link).toHaveAttribute('href', URL3D)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(link).toBeVisible()
  // Sits beside Apply.
  const apply = await page.getByRole('button', { name: 'Apply to FloorGen' }).boundingBox()
  const lb = (await link.boundingBox())!
  expect(Math.abs(lb.y - apply!.y)).toBeLessThan(60)

  // Make an unsaved edit, then reach the link with the keyboard only.
  await page.getByLabel('Horizontal position').fill('450')
  await page.getByRole('button', { name: 'Apply to FloorGen' }).focus()
  await page.keyboard.press('Tab')
  await expect(link).toBeFocused()

  const [popup] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')])
  expect(popup.url()).toBe(URL3D)

  // This session is untouched: same page, edit still there, nothing applied.
  await expect(page.getByLabel('Horizontal position')).toHaveValue('450')
  await expect(page.getByTestId('message')).not.toContainText('Verified')
})

test('the buttons stack when the inspector is too narrow for both', async ({ page }) => {
  await page.setViewportSize({ width: 250, height: 700 })
  const apply = (await page.getByRole('button', { name: 'Apply to FloorGen' }).boundingBox())!
  const lb = (await page.getByRole('link', { name: /Open in FloorGen 3D/ }).boundingBox())!
  expect(lb.y).toBeGreaterThan(apply.y + apply.height - 1)
  expect(lb.x + lb.width).toBeLessThanOrEqual(250)
})
