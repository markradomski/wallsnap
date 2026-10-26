import { expect, test, type Page } from '@playwright/test'

// FloorGen's state is simulated at the HTTP boundary (GET /api/wall, PUT /api/artwork), so each case is deterministic
// and independent of the shared mock project. Server-side conversion is covered by the Vitest adapter tests.

interface Art { width: number; height: number; u: number; v: number }
interface Detached { message: string; reasons: string[]; width: number; height: number; elevation: number }
interface Server {
  artwork: Art | null
  artworkId: string | null
  detached: Detached | null
  rev: number
  /** When set, GETs that carry ?item= (Reload) fail like this. */
  fail?: { status: number; body: object }
  gate?: Promise<void>
  putGate?: Promise<void>
}

const ART: Art = { width: 60, height: 45, u: 300, v: 120 }

async function setup(page: Page, init: Partial<Server> = {}) {
  const server: Server = { artwork: ART, artworkId: 'i_live1', detached: null, rev: 1000, ...init }
  const gets: string[] = []
  const puts: { rev: number; itemId: string | null; artwork: Art }[] = []
  let wall: unknown = null
  await page.route(/\/api\/wall\?/, async (route) => {
    gets.push(route.request().url())
    wall ??= ((await (await route.fetch()).json()) as { wall: unknown }).wall
    if (server.fail && route.request().url().includes('item=')) return route.fulfill({ status: server.fail.status, json: server.fail.body })
    await server.gate
    await route.fulfill({ json: { wall, artwork: server.artwork, artworkId: server.artworkId, detached: server.detached, rev: server.rev } })
  })
  await page.route('**/api/artwork', async (route) => {
    const body = route.request().postDataJSON()
    puts.push(body)
    await server.putGate
    await route.fulfill({ json: { artwork: body.artwork, artworkId: server.artworkId ?? 'i_new', rev: server.rev + 1, created: false } })
  })
  await page.goto('/')
  await page.getByLabel('Floor').selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Room A — north wall, 600 cm' })
  await expect(page.getByTestId('wall-dims')).toBeVisible()
  const reloads = () => gets.filter((u) => u.includes('item='))
  return { server, gets, puts, reloads }
}

const inputs = async (page: Page) => ({
  width: Number(await page.getByLabel('Width').inputValue()),
  height: Number(await page.getByLabel('Height').inputValue()),
  u: Number(await page.getByLabel('Horizontal position').inputValue()),
  v: Number(await page.getByLabel('Bottom elevation').inputValue()),
})
const reloadButton = (page: Page) => page.getByRole('button', { name: /Reload from FloorGen|Reloading/ })
const status = (page: Page) => page.getByTestId('save-status')

test.describe('the Reload button', () => {
  test('sits with the actions, has a refresh icon, and is keyboard reachable', async ({ page }) => {
    await setup(page)
    const btn = reloadButton(page)
    await expect(btn).toBeVisible()
    await expect(btn.locator('svg')).toHaveCount(1)
    await page.getByLabel('Bottom elevation').fill('131') // Apply is only enabled when something changed
    await page.getByRole('button', { name: /^Apply all changes/ }).focus()
    await page.keyboard.press('Tab')
    await expect(btn).toBeFocused()
  })

  test('shows a loading state while fetching, without reloading the browser page', async ({ page }) => {
    let release!: () => void
    const { server, reloads } = await setup(page)
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42))
    server.gate = new Promise<void>((r) => (release = r))
    await reloadButton(page).click()
    await expect(reloadButton(page)).toHaveText(/Reloading/)
    await expect(reloadButton(page)).toBeDisabled()
    await expect(reloadButton(page)).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('button', { name: /^Apply all changes/ })).toBeDisabled()
    release()
    await expect(reloadButton(page)).toHaveText(/Reload from FloorGen/)
    await expect(reloadButton(page)).toBeEnabled()
    expect(await page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(42) // same page, no browser reload
    expect(reloads()).toHaveLength(1)
  })

  test('is activated by the keyboard', async ({ page }) => {
    const { reloads } = await setup(page)
    await reloadButton(page).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => reloads().length).toBe(1)
  })
})

test.describe('reading the current FloorGen state', () => {
  test('an artwork moved and resized in FloorGen is reflected in the SVG, the inputs and the status', async ({ page }) => {
    const { server, reloads, puts } = await setup(page)
    expect(await inputs(page)).toEqual(ART)
    server.artwork = { width: 90, height: 55, u: 420, v: 150 }
    server.rev = 1010
    await reloadButton(page).click()
    await expect.poll(() => inputs(page)).toEqual({ width: 90, height: 55, u: 420, v: 150 })
    const rect = page.getByTestId('artwork')
    expect(Number(await rect.getAttribute('width'))).toBe(90)
    expect(Number(await rect.getAttribute('height'))).toBe(55)
    expect(Number(await rect.getAttribute('x'))).toBe(420 - 45) // centre-based u, from endpoint A
    await expect(status(page)).toHaveAttribute('data-state', 'synced')
    await expect(status(page)).toContainText('Loaded from FloorGen')
    await expect(page.getByTestId('message')).toContainText('revision 1010')
    // The artwork is read back by its persistent id, and nothing is written.
    expect(reloads()[0]).toContain('item=i_live1')
    expect(puts).toEqual([])
  })

  test('the next Apply uses the refreshed revision and the same artwork id', async ({ page }) => {
    const { server, puts } = await setup(page)
    server.rev = 1010
    await reloadButton(page).click()
    await expect(page.getByTestId('message')).toContainText('revision 1010')
    await page.getByLabel('Horizontal position').fill('450')
    await page.getByRole('button', { name: /^Apply all changes/ }).click()
    await expect.poll(() => puts.length).toBe(1)
    expect(puts[0]).toMatchObject({ rev: 1010, itemId: 'i_live1', artwork: { u: 450 } })
  })

  test('before any Reload, Apply carries the id loaded with the wall', async ({ page }) => {
    const { puts } = await setup(page)
    await page.getByLabel('Horizontal position').fill('500')
    await page.getByRole('button', { name: /^Apply all changes/ }).click()
    await expect.poll(() => puts.length).toBe(1)
    expect(puts[0]).toMatchObject({ rev: 1000, itemId: 'i_live1' })
  })

  test('a wall with no saved artwork reloads without an item id (nothing to look up)', async ({ page }) => {
    const { reloads, gets } = await setup(page, { artwork: null, artworkId: null })
    await expect(status(page)).toHaveAttribute('data-state', 'new')
    await reloadButton(page).click()
    await expect.poll(() => gets.length).toBe(2)
    expect(reloads()).toEqual([])
  })
})

test.describe('unsaved local edits', () => {
  test('ask first; Keep editing leaves every edit untouched and fetches nothing', async ({ page }) => {
    const { server, reloads } = await setup(page)
    server.artwork = { width: 90, height: 55, u: 420, v: 150 }
    await page.getByLabel('Horizontal position').fill('450')
    await page.getByLabel('Width').fill('70')
    await reloadButton(page).click()
    const dialog = page.getByTestId('reload-confirm')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Discard your unsaved edits?')
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused() // the safe default
    expect(reloads()).toHaveLength(0)
    await page.getByRole('button', { name: 'Keep editing' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await inputs(page)).toEqual({ width: 70, height: 45, u: 450, v: 120 })
    expect(reloads()).toHaveLength(0)
  })

  test('Escape cancels the prompt', async ({ page }) => {
    const { reloads } = await setup(page)
    await page.getByLabel('Bottom elevation').fill('99')
    await reloadButton(page).click()
    await expect(page.getByTestId('reload-confirm')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('reload-confirm')).toHaveCount(0)
    expect((await inputs(page)).v).toBe(99)
    expect(reloads()).toHaveLength(0)
  })

  test('Discard and reload replaces the edits with what FloorGen holds', async ({ page }) => {
    const { server, reloads } = await setup(page)
    server.artwork = { width: 90, height: 55, u: 420, v: 150 }
    await page.getByLabel('Horizontal position').fill('450')
    await reloadButton(page).click()
    await page.getByRole('button', { name: 'Discard and reload' }).click()
    await expect.poll(() => inputs(page)).toEqual({ width: 90, height: 55, u: 420, v: 150 })
    await expect(page.getByTestId('reload-confirm')).toHaveCount(0)
    expect(reloads()).toHaveLength(1)
    await expect(status(page)).toHaveAttribute('data-state', 'synced')
  })

  test('an untouched editor reloads immediately, with no prompt', async ({ page }) => {
    const { reloads } = await setup(page)
    await reloadButton(page).click()
    await expect.poll(() => reloads().length).toBe(1)
    await expect(page.getByTestId('reload-confirm')).toHaveCount(0)
  })

  test('a draft that is typed and left invalid still counts as an edit', async ({ page }) => {
    await setup(page)
    await page.getByLabel('Width').fill('')
    await reloadButton(page).click()
    await expect(page.getByTestId('reload-confirm')).toBeVisible()
  })

  test('theme and other preferences are untouched by Reload', async ({ page }) => {
    await setup(page)
    await page.getByRole('button', { name: 'Dark' }).click()
    await reloadButton(page).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    expect(await page.evaluate(() => localStorage.getItem('wallsnap.theme'))).toBe('dark')
  })
})

test.describe('when the artwork is no longer on the wall', () => {
  const detached: Detached = {
    message: 'Artwork is no longer positioned on this wall.',
    reasons: ['It is 214.9 cm in front of the wall surface.'],
    width: 80, height: 50, elevation: 130,
  }

  test('says so, draws no artwork and invents no coordinates', async ({ page }) => {
    const { server } = await setup(page)
    server.artwork = null
    server.detached = detached
    server.rev = 1020
    await reloadButton(page).click()
    await expect(status(page)).toHaveAttribute('data-state', 'detached')
    const card = page.getByTestId('status-card')
    await expect(card).toHaveAttribute('role', 'alert')
    await expect(card).toContainText('Artwork is no longer positioned on this wall.')
    await expect(card).toContainText('214.9 cm in front of the wall surface')
    await expect(page.getByTestId('artwork')).toHaveCount(0)
    await expect(page.getByTestId('handle-se')).toHaveCount(0)
    await expect(page.getByLabel('Horizontal position')).toBeDisabled()
    await expect(page.getByLabel('Horizontal position')).toHaveValue('')
    await expect(page.getByRole('button', { name: /^Apply all changes/ })).toBeDisabled()
  })

  test('recovery drafts it back with its own size; Apply then moves the same artwork id', async ({ page }) => {
    const { server, puts } = await setup(page)
    server.artwork = null
    server.detached = detached
    server.rev = 1020
    await reloadButton(page).click()
    await page.getByRole('button', { name: 'Place back on this wall' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'unsaved') // an edit of the saved artwork, not a new one
    expect(await inputs(page)).toEqual({ width: 80, height: 50, u: 300, v: 130 }) // its own size, centred on the wall
    await expect(page.getByTestId('artwork')).toBeVisible()
    await page.getByLabel('Horizontal position').fill('450')
    await page.getByRole('button', { name: /^Apply all changes/ }).click()
    await expect.poll(() => puts.length).toBe(1)
    expect(puts[0]).toMatchObject({ rev: 1020, itemId: 'i_live1', artwork: { width: 80, height: 50, u: 450, v: 130 } })
  })

  test('a drafted recovery counts as unsaved edits, so Reload asks before discarding it', async ({ page }) => {
    const { server } = await setup(page)
    server.artwork = null
    server.detached = detached
    await reloadButton(page).click()
    await page.getByRole('button', { name: 'Place back on this wall' }).click()
    await reloadButton(page).click()
    await expect(page.getByTestId('reload-confirm')).toBeVisible()
  })
})

test.describe('failures leave the local state alone', () => {
  test('a failed fetch shows the reason and keeps every local edit', async ({ page }) => {
    const { server, puts } = await setup(page)
    server.fail = { status: 502, body: { error: 'FloorGen readEntities failed: connection reset' } }
    await page.getByLabel('Horizontal position').fill('450')
    await page.getByLabel('Width').fill('75')
    await reloadButton(page).click()
    await page.getByRole('button', { name: 'Discard and reload' }).click()
    await expect(status(page)).toHaveAttribute('data-state', 'error')
    await expect(page.getByTestId('status-card')).toContainText('Could not reload from FloorGen: FloorGen readEntities failed: connection reset')
    expect(await inputs(page)).toEqual({ width: 75, height: 45, u: 450, v: 120 })
    await expect(page.getByTestId('artwork')).toBeVisible()
    expect(puts).toEqual([])
    await expect(reloadButton(page)).toBeEnabled() // and it can be tried again
  })

  test('a deleted artwork is an error, not stale data', async ({ page }) => {
    const { server } = await setup(page)
    server.fail = { status: 404, body: { error: 'The artwork no longer exists in FloorGen (it may have been deleted). Select the wall again to start a new one.', code: 'artwork_missing' } }
    await reloadButton(page).click()
    await expect(status(page)).toHaveAttribute('data-state', 'error')
    await expect(page.getByTestId('status-card')).toContainText('no longer exists in FloorGen')
    expect(await inputs(page)).toEqual(ART) // nothing was replaced
  })

  test('a missing wall is an error, not stale data', async ({ page }) => {
    const { server } = await setup(page)
    server.fail = { status: 404, body: { error: 'This wall is no longer available in FloorGen.', code: 'wall_missing' } }
    await reloadButton(page).click()
    await expect(page.getByTestId('status-card')).toContainText('This wall is no longer available in FloorGen.')
    expect(await inputs(page)).toEqual(ART)
  })

  test('FloorGen changing mid-read is reported as a reload error, and Apply still works against the old revision rules', async ({ page }) => {
    const { server } = await setup(page)
    server.fail = { status: 409, body: { error: 'FloorGen kept changing while WallSnap was reading it. Try again in a moment.', code: 'stale' } }
    await reloadButton(page).click()
    await expect(status(page)).toHaveAttribute('data-state', 'error') // a failed reload, not a save conflict
    await expect(page.getByTestId('status-card')).toContainText('Try again in a moment')
    server.fail = undefined
    await reloadButton(page).click()
    await expect(status(page)).toHaveAttribute('data-state', 'synced')
  })

  test('the error clears on the next edit like any other save error', async ({ page }) => {
    const { server } = await setup(page)
    server.fail = { status: 502, body: { error: 'boom' } }
    await reloadButton(page).click()
    await expect(status(page)).toHaveAttribute('data-state', 'error')
    await page.getByLabel('Horizontal position').fill('333')
    await expect(status(page)).toHaveAttribute('data-state', 'unsaved')
  })
})

test('Reload is unavailable while a save is in flight, and Apply while a reload is', async ({ page }) => {
  let release!: () => void
  const { server } = await setup(page)
  server.putGate = new Promise<void>((r) => (release = r))
  await page.getByLabel('Horizontal position').fill('450')
  await page.getByRole('button', { name: /^Apply all changes/ }).click()
  await expect(status(page)).toHaveAttribute('data-state', 'saving')
  await expect(reloadButton(page)).toBeDisabled()
  release()
  await expect(status(page)).toHaveAttribute('data-state', 'verified')
  await expect(reloadButton(page)).toBeEnabled()
})
