import { expect, test } from '@playwright/test'

// Mutating tests each use their own wall (south here) because workers share one mock server.
test('drag, numeric adjust and apply', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('MOCK ADAPTER')).toBeVisible()

  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — south wall, 600 cm' })
  await expect(page.getByText('Wall: 600 × 250 cm')).toBeVisible()

  const centre = page.getByLabel('Horizontal position')
  const bottom = page.getByLabel('Bottom elevation')
  await expect(centre).toHaveValue('300')

  // Drag right and up.
  const art = page.getByTestId('artwork')
  const box = (await art.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 120, y - 30, { steps: 5 })
  await page.mouse.up()
  expect(Number(await centre.inputValue())).toBeGreaterThan(350)
  expect(Number(await bottom.inputValue())).toBeGreaterThan(120)

  // Dragging far off the wall is clamped to its boundary.
  await page.mouse.move(box.x + 150, y)
  await page.mouse.down()
  await page.mouse.move(5000, y, { steps: 3 })
  await page.mouse.up()
  expect(Number(await centre.inputValue())).toBeLessThanOrEqual(570)

  // Keyboard nudge.
  await art.focus()
  const before = Number(await centre.inputValue())
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(centre).toHaveValue(String(Math.round((before - 10) * 10) / 10))

  // Numeric inputs + validation.
  await centre.fill('450')
  await page.getByLabel('Bottom elevation').fill('130')
  await page.getByLabel('Height').fill('250')
  await expect(page.getByText('Height cannot exceed 200 cm.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeDisabled()
  await page.getByLabel('Height').fill('50')

  await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
  await expect(page.getByTestId('message')).toContainText('Verified in FloorGen: created artwork 60×50 cm, horizontal position 450 cm, bottom elevation 130 cm')

  // Re-applying edits the same object (no duplicate).
  await centre.fill('300')
  await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
  await expect(page.getByTestId('message')).toContainText('updated artwork')
})

test('reserved ground-floor wall cannot be selected', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Floor').selectOption({ label: 'Ground floor' })
  await expect(page.getByRole('option', { name: /north wall, 700 cm \(reserved\)/ })).toHaveJSProperty('disabled', true)
})
