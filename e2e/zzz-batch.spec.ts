// Named zzz-… on purpose: these tests save and delete artworks on the mock Studio's south wall (state lasts for the whole run).
import { expect, test, type Page } from '@playwright/test'
import { makeImage } from './helpers3d'

const WALL = 'Studio — south wall, 600 cm' // a door at u 105..195 (sill 0, height 205), A at the east end
type Art = { id: string; artwork: { width: number; height: number; u: number; v: number } }
const server = async (page: Page) => ((await (await page.request.get('/api/wall?floor=f_ground&wall=gs_south')).json()) as { rev: number; artworks: Art[] }).artworks
const open = async (page: Page) => {
  await page.goto('/')
  await page.locator('header select').first().selectOption({ label: 'Ground floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: WALL })
  await expect(page.getByTestId('elevation')).toBeVisible()
}
const entries = (page: Page) => page.getByTestId('artwork-entry')
const apply = (page: Page) => page.getByRole('button', { name: /^Apply all changes/ })
const place = async (page: Page, u: number, v: number) => {
  await page.getByLabel('Horizontal position').fill(String(u))
  await page.getByLabel('Bottom elevation').fill(String(v))
}
const verified = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')
const puts = (page: Page) => {
  const list: { rev: number; itemId: string | null; newArtwork: boolean; artwork: Art['artwork'] }[] = []
  page.on('request', (r) => r.method() === 'PUT' && r.url().endsWith('/api/artwork') && list.push(r.postDataJSON()))
  return list
}
const read = async (page: Page, i: number) => {
  await entries(page).nth(i).click()
  return {
    u: Number(await page.getByLabel('Horizontal position').inputValue()), v: Number(await page.getByLabel('Bottom elevation').inputValue()),
    w: Number(await page.getByLabel('Width').inputValue()), h: Number(await page.getByLabel('Height').inputValue()),
  }
}

test('one Apply saves three new artworks and two moved ones, in order, without duplicates, and survives a reload', async ({ page }) => {
  const sent = puts(page)
  await open(page)
  // two saved artworks first (the empty wall starts with one draft artwork)
  await page.getByTestId('image-input').setInputFiles(await makeImage(page, 300, 200, 'one.png'))
  await place(page, 300, 100)
  await page.getByTestId('add-artwork').click()
  await page.getByTestId('image-input').setInputFiles(await makeImage(page, 200, 300, 'two.png'))
  await place(page, 400, 110)
  await apply(page).click()
  await verified(page)
  const first = await server(page)
  expect(first).toHaveLength(2)
  sent.length = 0

  // now: move both saved ones, add three new ones with images, and apply once
  await entries(page).nth(0).click()
  await place(page, 330, 90)
  await entries(page).nth(1).click()
  await place(page, 430, 95)
  for (const [i, name] of ['three.png', 'four.png', 'five.png'].entries()) {
    await page.getByTestId('add-artwork').click()
    await page.getByTestId('image-input').setInputFiles(await makeImage(page, 300 + i * 50, 300, name))
    await place(page, 480 + i * 30, 120 + i * 10)
  }
  await entries(page).nth(1).click() // the artwork selected before applying must stay selected
  const states = await entries(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
  expect(states).toEqual(['unsaved', 'unsaved', 'new', 'new', 'new'])
  await expect(apply(page)).toHaveText('Apply all changes (5)')
  await apply(page).click()
  await verified(page)
  await expect(page.getByTestId('message').first()).toContainText('all 5 pending artworks')
  await expect(page.getByTestId('message').first()).toContainText('3 created, 2 updated')

  // exactly five writes, one after another: each carries the revision the previous one produced
  expect(sent).toHaveLength(5)
  expect(sent.map((s) => s.newArtwork)).toEqual([false, false, true, true, true])
  expect(new Set(sent.map((s) => s.rev)).size).toBe(5)
  expect([...sent.map((s) => s.rev)]).toEqual([...sent.map((s) => s.rev)].sort((a, b) => a - b))
  expect(sent[0].itemId).toBe(first[0].id)
  expect(sent[1].itemId).toBe(first[1].id)
  // FloorGen holds five, with the right places; the two existing keep their ids
  const now = await server(page)
  expect(now).toHaveLength(5)
  expect(now.slice(0, 2).map((a) => a.id)).toEqual(first.map((a) => a.id))
  expect(now[0].artwork).toMatchObject({ u: 330, v: 90 })
  expect(now[1].artwork).toMatchObject({ u: 430, v: 95 })
  for (const e of await entries(page).evaluateAll((els) => els.map((x) => x.getAttribute('data-status')))) expect(e).toBe('saved')
  await expect(entries(page).nth(1)).toHaveAttribute('aria-pressed', 'true')
  // nothing left to apply, and applying again would create nothing
  await expect(apply(page)).toBeDisabled()
  await expect(apply(page)).toHaveText('Apply all changes')
  expect(sent).toHaveLength(5)

  // reload: positions, sizes and images are all there
  await page.reload()
  await page.locator('header select').first().selectOption({ label: 'Ground floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: WALL })
  await expect(entries(page)).toHaveCount(5)
  const back = []
  for (let i = 0; i < 5; i++) back.push(await read(page, i))
  expect(back.map((b) => [b.u, b.v])).toEqual(now.map((a) => [a.artwork.u, a.artwork.v]))
  expect(back.map((b) => [b.w, b.h])).toEqual(now.map((a) => [a.artwork.width, a.artwork.height]))
  const names = (await entries(page).allInnerTexts()).join(' ')
  for (const n of ['one.png', 'two.png', 'three.png', 'four.png', 'five.png']) expect(names).toContain(n)
  await expect(apply(page)).toBeDisabled()
  expect(sent).toHaveLength(5)
})

test('a pending artwork that breaks a rule is named in the list and blocks Apply until it is fixed', async ({ page }) => {
  const sent = puts(page)
  await open(page)
  const base = (await server(page)).length
  await page.getByTestId('add-artwork').click()
  await place(page, 150, 50) // across the door
  await page.getByTestId('add-artwork').click()
  await place(page, 250, 100) // fine
  const bad = entries(page).nth(base) // the first artwork added here
  await expect(bad).toHaveAttribute('data-status', 'invalid')
  await expect(bad).toContainText('Fix before applying')
  await expect(bad).toContainText(/door or window/)
  await expect(page.getByTestId('apply-blocked')).toContainText('(' + (base + 1) + ')')
  await expect(apply(page)).toBeDisabled()
  await apply(page).click({ force: true, trial: false }).catch(() => undefined)
  expect(sent).toHaveLength(0)
  await bad.click()
  await place(page, 300, 100)
  await expect(bad).not.toHaveAttribute('data-status', 'invalid')
  await expect(apply(page)).toBeEnabled()
})

test('a failure part-way says what saved and what is still pending, never duplicates, and can be retried', async ({ page }) => {
  await open(page)
  const before = (await server(page)).length
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('add-artwork').click()
    await place(page, 250 + i * 60, 100 + i * 10)
  }
  let n = 0
  await page.route('**/api/artwork', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    n++
    if (n === 2) return route.fulfill({ status: 422, json: { error: 'FloorGen rejected the placement: simulated.' } })
    return route.continue()
  })
  await apply(page).click()
  await expect(page.getByTestId('status-card')).toBeVisible()
  await expect(page.getByTestId('message')).toContainText('could not be saved')
  await expect(page.getByTestId('message')).toContainText('Saved:')
  await expect(page.getByTestId('message')).toContainText('Still pending:')
  const states = await entries(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
  expect(states.slice(-3)).toEqual(['saved', 'new', 'new'])
  expect((await server(page)).length).toBe(before + 1) // exactly one made it
  await expect(apply(page)).toHaveText('Apply all changes (2)')
  // retry: only the two pending ones are sent; the saved one is not created again
  await apply(page).click()
  await verified(page)
  expect((await server(page)).length).toBe(before + 3)
  expect(n).toBe(4) // 2 on the first try (one saved, one refused) + 2 on the retry
})

for (const [status, code, label] of [[409, 'stale', 'Revision conflict'], [502, 'partial', 'Partially saved']] as const) {
  test(`a ${code === 'stale' ? 'revision conflict' : 'partial write'} mid-batch stops the batch, says what saved, and blocks Apply until Reload`, async ({ page }) => {
    await open(page)
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('add-artwork').click()
      await place(page, 300 + i * 70, 100)
    }
    let n = 0
    await page.route('**/api/artwork', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      if (++n === 2) return route.fulfill({ status, json: { error: 'simulated', code } })
      return route.continue()
    })
    await apply(page).click()
    await expect(page.getByTestId('save-status')).toContainText(label)
    await expect(page.getByTestId('message')).toContainText('Saved:')
    await expect(page.getByTestId('message')).toContainText('Still pending:')
    expect(n).toBe(2) // the third was never attempted
    await expect(apply(page)).toBeDisabled()
  })
}

test('deleting one artwork still works on its own after a batch', async ({ page }) => {
  await open(page)
  const before = await server(page)
  expect(before.length).toBeGreaterThanOrEqual(3)
  await entries(page).nth(1).click()
  await page.getByTestId('delete-artwork').click()
  await page.getByRole('button', { name: 'Delete artwork' }).click()
  await expect(entries(page)).toHaveCount(before.length - 1)
  const after = await server(page)
  expect(after.map((a) => a.id)).toEqual(before.filter((_, i) => i !== 1).map((a) => a.id))
  for (const a of after) expect(before.find((b) => b.id === a.id)).toEqual(a)
})
