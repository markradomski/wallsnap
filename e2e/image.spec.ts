import { expect, test, type Page } from '@playwright/test'

// Uses the Studio walls of the mock project. Only the "saved artwork" test applies (on the south wall); the rest stay local
// drafts, and every Playwright test gets a fresh browser profile, so IndexedDB always starts empty.

const PICK = { floor: 'Ground floor', west: 'Studio — west wall, 400 cm', south: 'Studio — south wall, 600 cm' }
const DRAFT_KEY = 'mock-project/draft/f_ground/gs_west'

async function pick(page: Page, wall: string) {
  await page.getByLabel('Floor').selectOption({ label: PICK.floor })
  await page.getByRole('combobox').nth(1).selectOption({ label: wall })
  await expect(page.getByTestId('artwork')).toBeVisible()
}
const open = async (page: Page, wall = PICK.west) => {
  await page.goto('/')
  await pick(page, wall)
}

/** A real image encoded by the browser itself, so JPEG/PNG/WebP are all genuine. */
async function makeImage(page: Page, w: number, h: number, type: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png', name?: string) {
  const b64 = await page.evaluate(async ({ w, h, type }) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    g.fillStyle = '#d95f02'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#1b9e77'
    g.fillRect(0, 0, w / 2, h / 2)
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), type))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    bytes.forEach((x) => (s += String.fromCharCode(x)))
    return btoa(s)
  }, { w, h, type })
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png'
  return { name: name ?? `art-${w}x${h}.${ext}`, mimeType: type, buffer: Buffer.from(b64, 'base64') }
}

const upload = (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => page.getByTestId('image-input').setInputFiles(file)
const vals = async (page: Page) => ({
  width: Number(await page.getByLabel('Width').inputValue()),
  height: Number(await page.getByLabel('Height').inputValue()),
  u: Number(await page.getByLabel('Horizontal position').inputValue()),
  v: Number(await page.getByLabel('Bottom elevation').inputValue()),
})
const note = (page: Page) => page.getByTestId('image-note')

/** What is in the app's IndexedDB, read independently of the app code. */
const storedKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('wallsnap-images', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('images')
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          const q = db.transaction('images').objectStore('images').getAllKeys()
          q.onsuccess = () => {
            db.close()
            resolve(q.result.map(String))
          }
        }
      }),
  )
const putRaw = (page: Page, key: string, value: 'garbage-png' | 'string') =>
  page.evaluate(
    ({ key, value }) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open('wallsnap-images', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('images')
        req.onsuccess = () => {
          const db = req.result
          const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
          const record =
            value === 'string'
              ? { blob: 'not-a-blob', name: 'x.png', type: 'image/png', width: 10, height: 10, savedAt: 1 }
              : { blob: new Blob([bytes], { type: 'image/png' }), name: 'bad.png', type: 'image/png', width: 10, height: 10, savedAt: 1 }
          const tx = db.transaction('images', 'readwrite')
          tx.objectStore('images').put(record, key)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
    { key, value },
  )

test.describe('valid uploads', () => {
  for (const [type, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']] as const) {
    test(`${ext.toUpperCase()} is accepted, previewed and shown on the wall`, async ({ page }) => {
      await open(page)
      await expect(page.getByTestId('artwork-image')).toHaveCount(0)
      await upload(page, await makeImage(page, 200, 100, type))
      await expect(page.getByTestId('thumbnail')).toBeVisible()
      await expect(page.getByTestId('artwork-image')).toBeVisible()
      await expect(page.getByTestId('image-meta')).toContainText(`art-200x100.${ext}`)
      await expect(page.getByTestId('image-meta')).toContainText('200 × 100 px')
      await expect(note(page)).toHaveCount(0)
    })
  }

  test('the frame comes from the aspect ratio and a default width, not from pixels', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await expect.poll(() => vals(page)).toMatchObject({ width: 60, height: 30 })
    await open(page)
    await upload(page, await makeImage(page, 300, 400)) // portrait 3:4
    await expect.poll(() => vals(page)).toMatchObject({ width: 60, height: 80 })
    await open(page)
    await upload(page, await makeImage(page, 40, 20)) // same 2:1 ratio, 5x fewer pixels: same centimetres
    await expect.poll(() => vals(page)).toMatchObject({ width: 60, height: 30 })
    await expect(page.getByTestId('image-meta')).toContainText('ratio 2.00')
  })

  test('a very tall image is shrunk proportionally to the 200 cm limit', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 50, 400)) // 1:8 would be 60 x 480
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect.poll(async () => (await vals(page)).height).toBe(200) // shrunk to the limit
    const v = await vals(page)
    expect(v.width / v.height).toBeCloseTo(1 / 8, 2)
  })

  test('the image is drawn inside the artwork frame, whole and in proportion', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    const img = page.getByTestId('artwork-image')
    const frame = page.getByTestId('artwork')
    for (const a of ['x', 'y', 'width', 'height']) expect(await img.getAttribute(a)).toBe(await frame.getAttribute(a))
    await expect(img).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet') // never cropped or stretched
    const b = (await img.boundingBox())!
    expect(b.width / b.height).toBeCloseTo(2, 1)
  })

  test('the artwork stays selected, with its handles, and still moves when dragged', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) await expect(page.getByTestId(`handle-${h}`)).toBeVisible()
    const before = await vals(page)
    const box = (await page.getByTestId('artwork').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    const after = await vals(page)
    expect(after.u).toBeGreaterThan(before.u + 10)
    expect([after.width, after.height]).toEqual([before.width, before.height]) // moving never resizes
  })

  test('the image follows the frame continuously while dragging and while resizing', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    const same = async () => {
      const img = page.getByTestId('artwork-image')
      const frame = page.getByTestId('artwork')
      for (const a of ['x', 'y', 'width', 'height']) expect(await img.getAttribute(a), a).toBe(await frame.getAttribute(a))
    }
    const art = (await page.getByTestId('artwork').boundingBox())!
    await page.mouse.move(art.x + art.width / 2, art.y + art.height / 2)
    await page.mouse.down()
    for (const dx of [10, 30, 50]) {
      await page.mouse.move(art.x + art.width / 2 + dx, art.y + art.height / 2 - dx / 2)
      await same() // mid-gesture
    }
    await page.mouse.up()
    const h = (await page.getByTestId('hit-se').boundingBox())!
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    for (const d of [10, 25, 40]) {
      await page.mouse.move(h.x + h.width / 2 + d, h.y + h.height / 2 + d / 2)
      await same()
    }
    await page.mouse.up()
  })
})

test.describe('invalid uploads leave the current state untouched', () => {
  const expectRejected = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }, message: RegExp) => {
    const before = await vals(page)
    await upload(page, file)
    await expect(note(page)).toContainText(message)
    await expect(note(page)).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('thumbnail')).toHaveCount(0)
    await expect(page.getByTestId('artwork-image')).toHaveCount(0)
    expect(await vals(page)).toEqual(before) // the frame is not resized by a failed upload
    expect(await storedKeys(page)).toEqual([])
  }

  test('a text file with an image name and type', async ({ page }) => {
    await open(page)
    await expectRejected(page, { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not a picture at all') }, /is not a JPEG, PNG or WebP image/)
  })
  test('GIF', async ({ page }) => {
    await open(page)
    await expectRejected(page, { name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;') }, /not a JPEG, PNG or WebP image/)
  })
  test('SVG (could carry scripts)', async ({ page }) => {
    await open(page)
    await expectRejected(page, { name: 'art.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') }, /not a JPEG, PNG or WebP image/)
  })
  test('a PNG whose bytes are damaged', async ({ page }) => {
    await open(page)
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('definitely not valid image data'.repeat(5))])
    await expectRejected(page, { name: 'damaged.png', mimeType: 'image/png', buffer: png }, /could not be decoded/)
  })
  test('a file over the size limit is refused before it is read', async ({ page }) => {
    await open(page)
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16 * 1024 * 1024)])
    await expectRejected(page, { name: 'huge.png', mimeType: 'image/png', buffer: big }, /limit is 15 MB/)
  })
  test('an empty file', async ({ page }) => {
    await open(page)
    await expectRejected(page, { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, /empty/)
  })

  test('a rejected file does not disturb an image already in place', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    const before = await vals(page)
    const keys = await storedKeys(page)
    await upload(page, { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') })
    await expect(note(page)).toBeVisible()
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect(page.getByTestId('artwork-image')).toBeVisible()
    await expect(page.getByTestId('image-meta')).toContainText('art-200x100.png')
    expect(await vals(page)).toEqual(before)
    expect(await storedKeys(page)).toEqual(keys)
  })

  test('the error clears after a good upload', async ({ page }) => {
    await open(page)
    await upload(page, { name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('nope') })
    await expect(note(page)).toBeVisible()
    await upload(page, await makeImage(page, 100, 100))
    await expect(note(page)).toHaveCount(0)
  })
})

test.describe('proportional and unlocked resizing', () => {
  const ratio = async (page: Page) => {
    const v = await vals(page)
    return v.width / v.height
  }
  const drag = async (page: Page, handle: string, dx: number, dy: number) => {
    const b = (await page.getByTestId(`hit-${handle}`).boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 6 })
    await page.mouse.up()
  }

  test('is locked by default and keeps the ratio through every kind of handle', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await expect(page.getByLabel('Lock proportions')).toBeChecked()
    const w0 = (await vals(page)).width
    for (const [h, dx, dy] of [['se', 40, 5], ['e', 30, 0], ['n', 0, -25], ['w', -20, 0], ['sw', -15, 10]] as const) {
      await drag(page, h, dx, dy)
      expect(await ratio(page), `${h}`).toBeCloseTo(2, 1)
    }
    expect((await vals(page)).width).not.toBe(w0)
    await expect(page.getByTestId('ratio-note')).toHaveCount(0)
  })

  test('typing a width or height moves the other one with it while locked', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await page.getByLabel('Width').fill('90')
    await expect(page.getByLabel('Height')).toHaveValue('45')
    await page.getByLabel('Height').fill('20')
    await expect(page.getByLabel('Width')).toHaveValue('40')
  })

  test('unlocking allows free resizing, shows the frame/image mismatch, and the image stays whole', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await page.getByLabel('Lock proportions').uncheck()
    await drag(page, 'e', 60, 0)
    const v = await vals(page)
    expect(v.height).toBe(30) // height untouched
    expect(v.width).toBeGreaterThan(70)
    await expect(page.getByTestId('ratio-note')).toBeVisible()
    await expect(page.getByTestId('artwork-image')).toHaveAttribute('preserveAspectRatio', 'xMidYMid meet')
    const b = (await page.getByTestId('artwork-image').boundingBox())!
    expect(b.width / b.height).toBeGreaterThan(2.1) // the element is the frame; the picture inside is letterboxed, not stretched
    // Typing also stays independent while unlocked.
    await page.getByLabel('Width').fill('50')
    await expect(page.getByLabel('Height')).toHaveValue('30')
  })

  test('"Match image proportions" restores the ratio', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await page.getByLabel('Lock proportions').uncheck()
    await drag(page, 'e', 60, 0)
    await page.getByRole('button', { name: 'Match image proportions' }).click()
    expect(await ratio(page)).toBeCloseTo(2, 1)
    await expect(page.getByTestId('ratio-note')).toHaveCount(0)
  })

  test('without an image resizing is free, as before', async ({ page }) => {
    await open(page)
    const before = await vals(page)
    await drag(page, 'e', 50, 0)
    const after = await vals(page)
    expect(after.height).toBe(before.height)
    expect(after.width).toBeGreaterThan(before.width)
    await expect(page.getByLabel('Lock proportions')).toHaveCount(0)
  })

  test('a locked resize stops at the wall and the 200 cm limit without distorting', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 100, 100))
    await drag(page, 'ne', 3000, -3000)
    const v = await vals(page)
    expect(v.height).toBeLessThanOrEqual(200)
    expect(v.width / v.height).toBeCloseTo(1, 1)
  })
})

test.describe('persistence in this browser', () => {
  test('a draft image survives a page reload', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    expect(await storedKeys(page)).toEqual([DRAFT_KEY])
    await page.reload()
    await pick(page, PICK.west)
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect(page.getByTestId('artwork-image')).toBeVisible()
    await expect(page.getByTestId('image-meta')).toContainText('art-200x100.png')
    await expect(note(page)).toHaveCount(0)
  })

  test('each wall has its own draft image', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100))
    await pick(page, PICK.south)
    await expect(page.getByTestId('thumbnail')).toHaveCount(0)
    await pick(page, PICK.west)
    await expect(page.getByTestId('thumbnail')).toBeVisible()
  })

  test('a replacement image replaces the old one, keeps the width, and persists', async ({ page }) => {
    await open(page)
    await upload(page, await makeImage(page, 200, 100, 'image/png', 'first.png'))
    await expect(page.getByTestId('image-meta')).toContainText('first.png')
    const src1 = await page.getByTestId('thumbnail').getAttribute('src')
    await upload(page, await makeImage(page, 100, 200, 'image/jpeg', 'second.jpg'))
    await expect(page.getByTestId('image-meta')).toContainText('second.jpg')
    expect(await page.getByTestId('thumbnail').getAttribute('src')).not.toBe(src1)
    await expect.poll(() => vals(page)).toMatchObject({ width: 60, height: 120 }) // current width kept, new ratio
    expect(await storedKeys(page)).toEqual([DRAFT_KEY]) // one record, replaced
    await page.reload()
    await pick(page, PICK.west)
    await expect(page.getByTestId('image-meta')).toContainText('second.jpg')
    await expect(page.getByTestId('image-meta')).not.toContainText('first.png')
  })

  test('missing local image data is simply no image: no error', async ({ page }) => {
    await open(page)
    await expect(page.getByTestId('thumbnail')).toHaveCount(0)
    await expect(note(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeEnabled()
  })

  for (const kind of ['garbage-png', 'string'] as const) {
    test(`corrupted local image data (${kind}) is reported gracefully and can be replaced`, async ({ page }) => {
      await page.goto('/')
      await putRaw(page, DRAFT_KEY, kind)
      await page.reload()
      await pick(page, PICK.west)
      await expect(note(page)).toContainText('could not be read')
      await expect(page.getByTestId('thumbnail')).toHaveCount(0)
      await expect(page.getByTestId('artwork-image')).toHaveCount(0)
      // The rest of the editor works: geometry can still be edited and applied.
      await page.getByLabel('Horizontal position').fill('250')
      await expect(page.getByRole('button', { name: 'Apply to FloorGen' })).toBeEnabled()
      // And a replacement fixes it.
      await upload(page, await makeImage(page, 100, 100))
      await expect(note(page)).toHaveCount(0)
      await expect(page.getByTestId('thumbnail')).toBeVisible()
      await page.reload()
      await pick(page, PICK.west)
      await expect(page.getByTestId('thumbnail')).toBeVisible()
    })
  }

  test('blocked browser storage: the image still shows this session, with a clear warning', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: { open() { throw new Error('blocked') } }, configurable: true })
    })
    await open(page)
    await expect(note(page)).toContainText('unavailable') // loading found storage blocked
    await upload(page, await makeImage(page, 200, 100))
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect(page.getByTestId('artwork-image')).toBeVisible()
    await expect(note(page)).toContainText('will not be there after a reload')
    await page.getByLabel('Horizontal position').fill('250') // editing still works
    await expect(page.getByLabel('Horizontal position')).toHaveValue('250')
  })
})

test.describe('FloorGen receives geometry only', () => {
  test('a saved artwork moves its image to the artwork id, sends no image data, and is verified by read-back', async ({ page }) => {
    const requests: { method: string; url: string; body: string }[] = []
    page.on('request', (r) => r.url().includes('/api/') && requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' }))

    await open(page, PICK.south)
    await upload(page, await makeImage(page, 200, 100, 'image/png', 'saved-art.png'))
    await expect.poll(() => vals(page)).toMatchObject({ width: 60, height: 30 })
    expect(await storedKeys(page)).toEqual(['mock-project/draft/f_ground/gs_south'])
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]) // choosing an image never writes anything

    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'verified')
    await expect(page.getByTestId('message')).toContainText('Verified in FloorGen: created artwork 60×30 cm')

    // Only the geometry was sent: no image bytes, no data URL, no file name.
    const puts = requests.filter((r) => r.method === 'PUT')
    expect(puts).toHaveLength(1)
    const sent = JSON.parse(puts[0].body)
    expect(Object.keys(sent).sort()).toEqual(['artwork', 'floorId', 'itemId', 'newArtwork', 'rev', 'wallId']) // newArtwork is a plain boolean: create rather than update
    expect(Object.keys(sent.artwork).sort()).toEqual(['height', 'u', 'v', 'width'])
    expect(puts[0].body.length).toBeLessThan(400)
    expect(puts[0].body).not.toMatch(/data:|png|saved-art|blob/i)
    expect(requests.every((r) => r.body.length < 400)).toBe(true) // nothing large went anywhere

    // The draft became the saved artwork's image (keyed by its persistent id), and the thumbnail never flickered away.
    const saved = await page.evaluate(async () => (await (await fetch('/api/wall?floor=f_ground&wall=gs_south')).json()).artworkId as string)
    expect(saved).toMatch(/^i_/)
    expect(await storedKeys(page)).toEqual([`mock-project/item/${saved}`])
    await expect(page.getByTestId('thumbnail')).toBeVisible()

    // A second Apply updates the same artwork id.
    await page.getByLabel('Horizontal position').fill('350')
    await page.getByRole('button', { name: 'Apply to FloorGen' }).click()
    await expect(page.getByTestId('message')).toContainText('updated artwork')
    expect(JSON.parse(requests.filter((r) => r.method === 'PUT')[1].body).itemId).toBe(saved)

    // After a browser reload the saved artwork's geometry comes back from FloorGen and its image from local storage.
    await page.reload()
    await pick(page, PICK.south)
    await expect(page.getByTestId('thumbnail')).toBeVisible()
    await expect(page.getByTestId('image-meta')).toContainText('saved-art.png')
    expect((await vals(page)).u).toBe(350)
  })

  test('the inspector states plainly where the image lives and what FloorGen gets', async ({ page }) => {
    await open(page)
    const text = await page.getByTestId('image-storage-note').innerText()
    expect(text).toMatch(/stored in this browser only/i)
    expect(text).toMatch(/FloorGen receives the artwork's size and position/)
    expect(text).toMatch(/not shown in FloorGen 3D/)
  })

  test('Reload from FloorGen keeps the local image for the same artwork', async ({ page }) => {
    await open(page, PICK.south) // the artwork saved by the previous test (same mock server run)
    await upload(page, await makeImage(page, 100, 100, 'image/png', 'keep.png'))
    await page.getByRole('button', { name: 'Reload from FloorGen' }).click()
    await page.getByRole('button', { name: 'Discard and reload' }).click().catch(() => undefined)
    await expect(page.getByTestId('thumbnail')).toBeVisible()
  })
})
