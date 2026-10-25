import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_WIDTH_CM, MAX_IMAGE_BYTES, checkFileSize, checkImageSize, frameForRatio, ratioDiffers, sniffImageType,
} from './image'

const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)])
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0])
const text = (s: string) => new TextEncoder().encode(s.padEnd(16, ' '))

describe('sniffImageType: trusts the bytes, not the name', () => {
  it('recognises JPEG, PNG and WebP', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(sniffImageType(webp)).toBe('image/webp')
  })
  it('refuses GIF, SVG, HTML, plain text, PDF and empty data', () => {
    for (const s of ['GIF89a', '<svg xmlns="x">', '<!doctype html>', 'hello world', '%PDF-1.7']) expect(sniffImageType(text(s))).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
  })
  it('does not accept a RIFF file that is not WebP (e.g. WAV)', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])
    expect(sniffImageType(wav)).toBeNull()
  })
  it('does not accept a truncated PNG signature', () => {
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })
})

describe('size limits', () => {
  it('rejects empty and oversized files, accepts the limit exactly', () => {
    expect(checkFileSize(0).ok).toBe(false)
    expect(checkFileSize(MAX_IMAGE_BYTES).ok).toBe(true)
    const big = checkFileSize(MAX_IMAGE_BYTES + 1)
    expect(big.ok).toBe(false)
    expect(!big.ok && big.message).toMatch(/limit is 15 MB/)
  })
  it('rejects absurd or unusable pixel sizes', () => {
    expect(checkImageSize(4000, 3000).ok).toBe(true)
    expect(checkImageSize(0, 100).ok).toBe(false)
    expect(checkImageSize(20000, 100).ok).toBe(false)
    expect(checkImageSize(11000, 11000).ok).toBe(false) // within the side limit, over the pixel budget
  })
})

describe('frameForRatio: dimensions come from the aspect ratio, never from pixels', () => {
  const wall = { length: 600, height: 250 }
  it('uses the default width and derives height from the ratio', () => {
    expect(frameForRatio(wall, 2, DEFAULT_IMAGE_WIDTH_CM)).toEqual({ width: 60, height: 30 })
    expect(frameForRatio(wall, 0.8, 60)).toEqual({ width: 60, height: 75 })
    expect(frameForRatio(wall, 1, 60)).toEqual({ width: 60, height: 60 })
  })
  it('is the same for a 200 px and a 20000 px version of the same picture', () => {
    expect(frameForRatio(wall, 4000 / 3000, 60)).toEqual(frameForRatio(wall, 200 / 150, 60))
  })
  it('keeps the ratio when shrinking to the 200 cm height limit', () => {
    const f = frameForRatio(wall, 0.25, 100) // 100 x 400 would be too tall
    expect(f.height).toBe(200)
    expect(f.width / f.height).toBeCloseTo(0.25, 2)
  })
  it('keeps the ratio when the wall is shorter or narrower than the frame', () => {
    const short = frameForRatio({ length: 600, height: 120 }, 1, 150)
    expect(short).toEqual({ width: 120, height: 120 })
    const narrow = frameForRatio({ length: 40, height: 250 }, 2, 100)
    expect(narrow).toEqual({ width: 40, height: 20 })
  })
  it('never goes below the 1 cm minimum', () => {
    const f = frameForRatio(wall, 500, 60) // a hairline panorama
    expect(f.height).toBeGreaterThanOrEqual(1)
  })
  it('can also scale up to a given width (replacement keeps the current width)', () => {
    expect(frameForRatio(wall, 1.5, 120)).toEqual({ width: 120, height: 80 })
  })
})

describe('ratioDiffers', () => {
  it('tolerates rounding but flags a real mismatch', () => {
    expect(ratioDiffers(60, 45, 4 / 3)).toBe(false)
    expect(ratioDiffers(60, 45.2, 4 / 3)).toBe(false)
    expect(ratioDiffers(60, 60, 4 / 3)).toBe(true)
  })
})
