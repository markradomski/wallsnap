// Named zz-… on purpose: these tests SAVE artworks on several walls of the mock project, whose state lasts for the whole run,
// so they run after every spec that expects those walls to be empty.
import { expect, test, type Page } from '@playwright/test'
import { mockTownhouse, type GenericSpec } from '../src/viewer3d/glbFixture'
import { WALLS, debug3d, importModel, makeImage, openWall, ready3d, state3d, to3d, trackWrites } from './helpers3d'

type Saved = { id: string; floorId: string; x: number; y: number; width: number; height: number; elevation: number; rotation: number; wall: { id: string } | null }
const saved = async (page: Page) => ((await (await page.request.get('/api/artworks')).json()) as { artworks: Saved[] }).artworks
const byWall = async (page: Page, wallId: string) => (await saved(page)).find((a) => a.wall?.id === wallId)!

async function saveOn(page: Page, floor: 'First floor' | 'Ground floor', wall: string, u: string, v: string, image = false) {
  await openWall(page, floor, wall)
  await page.getByLabel('Horizontal position').fill(u)
  await page.getByLabel('Bottom elevation').fill(v)
  if (image) await page.getByTestId('image-input').setInputFiles(await makeImage(page, 200, 120))
  await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')
}
/** A (north), B (east, with an image) on the first floor, C on the ground floor (slanted wall). Returns their saved items. */
async function saveThree(page: Page) {
  await saveOn(page, 'First floor', WALLS.north, '450', '100')
  await saveOn(page, 'First floor', WALLS.east, '100', '90', true)
  await saveOn(page, 'Ground floor', WALLS.studioEast, '200', '100')
  return { A: await byWall(page, 'fl_north'), B: await byWall(page, 'fl_east'), C: await byWall(page, 'gs_east') }
}
const generic = (a: Saved, floor: number): GenericSpec => ({ floor, x: a.x, y: a.y, width: a.width, height: a.height, elevation: a.elevation, rotation: a.rotation })
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4)
const ids = async (page: Page) => {
  const d = await state3d(page)
  return { selected: d.selectedId, others: d.others.map((o) => o.id), d }
}

test('every saved artwork is in 3D, whichever wall is selected, and none disappears when the selection changes', async ({ page }) => {
  const { A, B, C } = await saveThree(page)
  await openWall(page, 'First floor', WALLS.north)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  await expect.poll(async () => (await state3d(page)).others.length).toBeGreaterThanOrEqual(2)
  let s = await ids(page)
  expect(s.selected).toBe(A.id)
  expect(s.others).toEqual(expect.arrayContaining([B.id, C.id]))
  expect(s.others).not.toContain(A.id) // the selected one is drawn from the editor's own state, never twice
  // each is where FloorGen holds it: B's plane sits just in front of its saved item (within half its depth and the gap)
  const b = s.d.others.find((o) => o.id === B.id)!
  expect(Math.abs(b.framePosition[0] - B.x / 100)).toBeLessThan(0.05) // ...but within a few cm of it (half depth + gap)
  expect(b.frameSize).toEqual([B.width / 100, B.height / 100])
  // switch the selected wall: the union of selected + others is unchanged
  for (const wall of [WALLS.east, WALLS.south, WALLS.north]) {
    await page.getByRole('combobox').nth(1).selectOption({ label: wall })
    await expect.poll(async () => (await state3d(page)).selectedId).not.toBeNull()
    s = await ids(page)
    const all = new Set([...(s.selected ? [s.selected] : []), ...s.others])
    for (const id of [A.id, B.id, C.id]) expect(all, `${id} on ${wall}`).toContain(id)
    expect(s.others).not.toContain(s.selected)
  }
})

test('an unsaved change to the selected artwork moves only that one, in 3D', async ({ page }) => {
  const { A, B, C } = await saveThree(page)
  await openWall(page, 'First floor', WALLS.east)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  await expect.poll(async () => (await state3d(page)).others.length).toBeGreaterThanOrEqual(2)
  const { writes } = trackWrites(page)
  const before = await state3d(page)
  expect(before.selectedId).toBe(B.id)
  await page.getByLabel('Horizontal position').fill('250')
  await expect(page.getByTestId('preview-badge')).toContainText('unsaved')
  await expect.poll(async () => near((await state3d(page)).artwork.framePosition, before.artwork.framePosition)).toBe(false)
  const after = await state3d(page)
  for (const id of [A.id, C.id]) {
    expect(after.others.find((o) => o.id === id)!.framePosition).toEqual(before.others.find((o) => o.id === id)!.framePosition)
  }
  expect(after.others.map((o) => o.id)).not.toContain(B.id)
  expect(writes).toEqual([])
})

test('images come from local storage after a reload; an artwork without one is a neutral frame; nothing is written', async ({ page }) => {
  const { B, C } = await saveThree(page)
  await openWall(page, 'First floor', WALLS.north)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  const { writes } = trackWrites(page)
  await page.reload()
  await page.locator('header select').first().selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.north })
  await expect(page.getByTestId('artwork')).toBeVisible()
  await to3d(page)
  await ready3d(page) // the model itself is restored from the browser too
  await expect.poll(async () => (await state3d(page)).others.find((o) => o.id === B.id)?.textured).toBe(true)
  const d = await state3d(page)
  const c = d.others.find((o) => o.id === C.id)!
  expect(c.textured).toBe(false) // no image stored for C: a plain frame, still there
  expect(c.frameSize).toEqual([C.width / 100, C.height / 100])
  expect(writes).toEqual([])
})

test('artworks on other floors follow the floor visibility control', async ({ page }) => {
  const { A, B, C } = await saveThree(page)
  await openWall(page, 'Ground floor', WALLS.studioEast)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  await expect.poll(async () => (await state3d(page)).others.length).toBeGreaterThanOrEqual(2)
  const vis = async () => Object.fromEntries((await state3d(page)).others.map((o) => [o.id, o.visible]))
  // ground floor selected: floors above are hidden, and so are their artworks
  expect(await vis()).toMatchObject({ [A.id]: false, [B.id]: false })
  await page.getByLabel('Show upper floors').check()
  await expect.poll(vis).toMatchObject({ [A.id]: true, [B.id]: true })
  await page.getByLabel('Show upper floors').uncheck()
  await expect.poll(vis).toMatchObject({ [A.id]: false, [B.id]: false })
  // from the first floor, the ground floor's artwork is visible (floors below always are)
  await page.locator('header select').first().selectOption({ label: 'First floor' })
  await page.getByRole('combobox').nth(1).selectOption({ label: WALLS.north })
  await expect.poll(async () => (await debug3d(page))?.others.find((o) => o.id === C.id)?.visible).toBe(true)
})

test("each artwork's stand-in in the model is hidden once, and unrelated geometry stays", async ({ page }) => {
  const { A, B, C } = await saveThree(page)
  await openWall(page, 'First floor', WALLS.north)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800, generic: [generic(A, 1), generic(B, 1), generic(C, 0)] }))
  await ready3d(page)
  await expect.poll(async () => (await state3d(page)).others.length).toBeGreaterThanOrEqual(2)
  const d = await state3d(page)
  expect(d.match.status).toBe('exact') // the selected one
  for (const id of [B.id, C.id]) expect(d.others.find((o) => o.id === id)!.match, id).toBe('exact')
  await expect(page.getByTestId('viewer-note').filter({ hasText: /placeholder|exported/ })).toHaveCount(0)
  // the model's other first-floor furniture (the sofa block) was not touched: it is still in the scene's triangle count
  expect(d.groups.length).toBe(3)
})

test('Orbit and Walk both keep every artwork; walking never changes the set', async ({ page }) => {
  const { A, B, C } = await saveThree(page)
  await openWall(page, 'First floor', WALLS.north)
  await to3d(page)
  await importModel(page, mockTownhouse({ x1Cm: 800 }))
  await ready3d(page)
  await expect.poll(async () => (await state3d(page)).others.length).toBeGreaterThanOrEqual(2)
  const set = async () => [...(await ids(page)).others, (await state3d(page)).selectedId].sort()
  const orbit = await set()
  await page.getByTestId('nav-walk').click()
  await expect.poll(async () => (await state3d(page)).walk.x).not.toBeNull()
  expect(await set()).toEqual(orbit)
  await page.getByTestId('nav-orbit').click()
  expect(await set()).toEqual(orbit)
  expect(orbit).toEqual(expect.arrayContaining([A.id, B.id, C.id]))
})
