// Named zz-… on purpose: these tests SAVE and DELETE artworks on the mock Studio's west wall, whose state lasts for the whole
// run, so they come after every spec that expects walls to be empty.
import { expect, test, type Page } from '@playwright/test'
import { mockTownhouse } from '../src/viewer3d/glbFixture'
import { WALLS, importModel, makeImage, ready3d, state3d, to3d, trackWrites } from './helpers3d'

const WALL = 'Studio — west wall, 400 cm'
const apiWall = async (page: Page) =>
  ((await (await page.request.get('/api/wall?floor=f_ground&wall=gs_west')).json()) as { rev: number; artworks: { id: string; artwork: { width: number; height: number; u: number; v: number } }[] })
const open = async (page: Page, wall = WALL, floor = 'Ground floor') => {
  await page.goto('/')
  await page.locator('header select').first().selectOption({ label: floor })
  await page.getByRole('combobox').nth(1).selectOption({ label: wall })
  await expect(page.getByTestId('elevation')).toBeVisible()
}
const entries = (page: Page) => page.getByTestId('artwork-entry')
const field = (page: Page, label: string) => page.getByLabel(label)
const num = async (page: Page, label: string) => Number(await field(page, label).inputValue())
const applyBtn = (page: Page) => page.getByRole('button', { name: /^Apply all changes/ })
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')

async function place(page: Page, u: string, v: string) {
  await field(page, 'Horizontal position').fill(u)
  await field(page, 'Bottom elevation').fill(v)
}

test('add three artworks with three images, edit each independently, save, reload, change one, delete one', async ({ page }) => {
  const { writes } = trackWrites(page)
  await open(page)
  const before = (await apiWall(page)).artworks.length // the shared mock may already hold some from other specs
  expect(before).toBe(0)

  // 1. three artworks, three images
  await page.getByTestId('image-input').setInputFiles(await makeImage(page, 300, 200, 'first.png'))
  await page.getByTestId('add-artwork').click()
  await expect(entries(page)).toHaveCount(2)
  await page.getByTestId('image-input').setInputFiles(await makeImage(page, 200, 300, 'second.png'))
  await page.getByTestId('add-artwork').click()
  await expect(entries(page)).toHaveCount(3)
  await page.getByTestId('image-input').setInputFiles(await makeImage(page, 400, 400, 'third.png'))
  await expect(entries(page).nth(0)).toContainText('first.png')
  await expect(entries(page).nth(1)).toContainText('second.png')
  await expect(entries(page).nth(2)).toContainText('third.png')
  await expect(entries(page).nth(2)).toHaveAttribute('aria-pressed', 'true') // the added one is selected

  // 2. select each and give it its own place; only the selected one has handles
  const spots = [['100', '100'], ['200', '120'], ['300', '80']]
  for (let i = 0; i < 3; i++) {
    await entries(page).nth(i).click()
    await expect(entries(page).nth(i)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('handle-n')).toHaveCount(1)
    await place(page, spots[i][0], spots[i][1])
  }
  // a real drag on the middle one moves only that one
  await entries(page).nth(1).click()
  await expect(page.getByTestId('other-artwork')).toHaveCount(2)
  const box = (await page.getByTestId('artwork').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  const movedU = await num(page, 'Horizontal position')
  expect(movedU).toBeGreaterThan(205)
  await entries(page).nth(0).click()
  expect(await num(page, 'Horizontal position')).toBe(100) // untouched by the drag of the other
  await entries(page).nth(1).click()
  const mid = { u: await num(page, 'Horizontal position'), v: await num(page, 'Bottom elevation'), w: await num(page, 'Width'), h: await num(page, 'Height') }

  // 3. one Apply saves all three: each is a new FloorGen item
  await expect(page.getByRole('button', { name: /^Apply all changes/ })).toHaveText('Apply all changes (3)')
  await page.getByRole('button', { name: /^Apply all changes/ }).click()
  await saved(page)
  expect((await apiWall(page)).artworks).toHaveLength(3)
  for (let i = 0; i < 3; i++) await expect(entries(page).nth(i)).toContainText('Saved')
  const ids = (await apiWall(page)).artworks.map((a) => a.id)
  expect(new Set(ids).size).toBe(3)
  expect(writes.filter((w) => w.startsWith('PUT'))).toHaveLength(3)

  // 4. reload the browser: all three come back with their images and places
  await page.reload()
  await page.locator('header select').first().selectOption({ label: 'Ground floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: WALL })
  await expect(entries(page)).toHaveCount(3)
  const server = await apiWall(page)
  expect(server.artworks).toHaveLength(3)
  const names = await entries(page).allInnerTexts()
  expect(names.join(' ')).toMatch(/first\.png/)
  expect(names.join(' ')).toMatch(/second\.png/)
  expect(names.join(' ')).toMatch(/third\.png/)
  // the image belongs to the right artwork: the thumbnail of each entry is its own picture
  const thumbs = await page.locator('[data-testid=artwork-entry] img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).naturalWidth / (e as HTMLImageElement).naturalHeight))
  expect(thumbs.map((r) => +r.toFixed(2)).sort()).toEqual([0.67, 1, 1.5])
  await entries(page).nth(1).click()
  expect({ u: await num(page, 'Horizontal position'), v: await num(page, 'Bottom elevation'), w: await num(page, 'Width'), h: await num(page, 'Height') }).toEqual(mid)

  // 5. change one and save it: the other two are unchanged on the server
  const beforeEdit = (await apiWall(page)).artworks
  await entries(page).nth(0).click()
  await place(page, '150', '90')
  await applyBtn(page).click()
  await saved(page)
  const afterEdit = (await apiWall(page)).artworks
  expect(afterEdit).toHaveLength(3)
  const changed = afterEdit.filter((a) => JSON.stringify(a) !== JSON.stringify(beforeEdit.find((b) => b.id === a.id)))
  expect(changed).toHaveLength(1)
  expect(changed[0].artwork).toMatchObject({ u: 150, v: 90 })

  // 6. delete one: asks first, removes only that one, keeps the other two and their images
  await entries(page).nth(2).click()
  const victim = (await apiWall(page)).artworks.find((a) => a.artwork.u === 300) ?? afterEdit[2]
  await page.getByTestId('delete-artwork').click()
  await expect(page.getByTestId('delete-confirm')).toBeVisible()
  await page.getByRole('button', { name: 'Keep it' }).click()
  expect((await apiWall(page)).artworks).toHaveLength(3) // nothing happened
  await page.getByTestId('delete-artwork').click()
  await page.getByRole('button', { name: 'Delete artwork' }).click()
  await expect(entries(page)).toHaveCount(2)
  const left = (await apiWall(page)).artworks
  expect(left).toHaveLength(2)
  expect(left.map((a) => a.id)).not.toContain(victim.id)
  for (const a of left) expect(afterEdit.find((b) => b.id === a.id)).toEqual(a) // untouched
  expect(await page.locator('[data-testid=artwork-entry] img').count()).toBe(2)
})

test('unsaved edits and new artworks survive switching walls and coming back', async ({ page }) => {
  await open(page)
  const base = (await apiWall(page)).artworks.length
  await expect(entries(page)).toHaveCount(Math.max(base, 1))
  await page.getByTestId('add-artwork').click()
  const n = base + 1 + (base === 0 ? 1 : 0)
  await expect(entries(page)).toHaveCount(n)
  await place(page, '222', '77')
  await page.getByRole('combobox').nth(1).selectOption({ label: 'Studio — east wall, 412 cm' })
  await expect(page.getByTestId('wall-name')).toContainText('east wall')
  await page.getByRole('combobox').nth(1).selectOption({ label: WALL })
  await expect(entries(page)).toHaveCount(n)
  await entries(page).nth(n - 1).click()
  expect(await num(page, 'Horizontal position')).toBe(222)
  expect(await num(page, 'Bottom elevation')).toBe(77)
  await expect(entries(page).nth(n - 1)).toContainText('Not saved yet')
  // an unsaved artwork is simply discarded, with no confirmation and no FloorGen call
  const { writes } = trackWrites(page)
  await page.getByTestId('delete-artwork').click()
  await expect(entries(page)).toHaveCount(n - 1)
  expect(writes).toEqual([])
})

test('all of a wall\'s artworks, saved or edited, are in 3D beside every other saved artwork', async ({ page }) => {
  await open(page)
  const server = (await apiWall(page)).artworks
  expect(server.length).toBeGreaterThanOrEqual(1)
  await page.getByTestId('add-artwork').click() // a new, unsaved one: no export, no save needed to see it
  await place(page, '300', '90')
  await entries(page).nth(0).click() // a saved one is selected; the new one is one of "the others" on this wall
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  const { writes } = trackWrites(page)
  await expect.poll(async () => {
    const d = await state3d(page)
    return [d.selectedId, ...d.others.map((o) => o.id)].filter(Boolean).length
  }).toBeGreaterThanOrEqual(server.length + 1)
  const d = await state3d(page)
  const present = new Set([d.selectedId, ...d.others.map((o) => o.id)])
  for (const a of server) expect(present, a.id).toContain(a.id)
  expect(d.others.some((o) => o.id.startsWith('new-'))).toBe(true) // the unsaved artwork is drawn too
  await page.getByTestId('nav-walk').click()
  await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
  const w = await state3d(page)
  expect(w.others.map((o) => o.id).sort()).toEqual(d.others.map((o) => o.id).sort())
  expect(writes).toEqual([])
})
