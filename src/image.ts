import { MAX_ART_HEIGHT, MIN_SIZE, round1, type WallDims } from './geometry'

export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type ImageType = (typeof ALLOWED_TYPES)[number]
export const TYPE_LABEL = 'JPEG, PNG or WebP'

/** Sensible limits: a phone photo is a few MB; anything far beyond is almost certainly a mistake. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGE_SIDE_PX = 12000
export const MAX_IMAGE_PIXELS = 80_000_000
/** Starting width (cm) for a first image. Pixels say nothing about physical size, so this is only a default. */
export const DEFAULT_IMAGE_WIDTH_CM = 60

/** The real type from the file's leading bytes: a file's name or declared MIME type can lie, and SVG/GIF are refused. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const is = (...b: number[]) => b.every((v, i) => head[i] === v)
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  // RIFF....WEBP
  if (is(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp'
  return null
}

export type Checked = { ok: true } | { ok: false; message: string }

export function checkFileSize(bytes: number): Checked {
  if (bytes <= 0) return { ok: false, message: 'That file is empty.' }
  if (bytes > MAX_IMAGE_BYTES) {
    return { ok: false, message: `That file is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB.` }
  }
  return { ok: true }
}

export function checkImageSize(width: number, height: number): Checked {
  if (!(width >= 1 && height >= 1)) return { ok: false, message: 'The image has no usable size.' }
  if (width > MAX_IMAGE_SIDE_PX || height > MAX_IMAGE_SIDE_PX || width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, message: `The image is ${width} × ${height} px; the limit is ${MAX_IMAGE_SIDE_PX} px on a side.` }
  }
  return { ok: true }
}

export const aspectRatio = (width: number, height: number) => width / height

/**
 * A frame for an image of `ratio` (width ÷ height) at about `widthCm`, shrunk proportionally if it would exceed the
 * 200 cm maximum height or the wall. Never distorts: the ratio is kept (to 0.1 cm rounding).
 */
export function frameForRatio(wall: WallDims, ratio: number, widthCm: number): { width: number; height: number } {
  let width = Math.max(MIN_SIZE, widthCm)
  let height = width / ratio
  const scale = Math.min(1, Math.min(MAX_ART_HEIGHT, wall.height) / height, wall.length / width)
  width *= scale
  height *= scale
  if (height < MIN_SIZE) {
    width *= MIN_SIZE / height
    height = MIN_SIZE
  }
  return { width: round1(width), height: round1(height) }
}

/** True when the frame is visibly a different shape from the image (so the image is shown fitted, not filled). */
export const ratioDiffers = (frameW: number, frameH: number, imageRatio: number, tolerance = 0.01) =>
  Math.abs(frameW / frameH - imageRatio) / imageRatio > tolerance

// ---- Browser-only helpers (decoding) ----

/** Decode to confirm the bytes really are an image, and read its pixel size. Rejects when it cannot be decoded. */
export function decodeImage(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

export type Accepted = { ok: true; blob: Blob; type: ImageType; name: string; width: number; height: number }

/** Validate an uploaded file by size, real content type and decodability. Never touches the network. */
export async function acceptImageFile(file: File): Promise<Accepted | { ok: false; message: string }> {
  const size = checkFileSize(file.size)
  if (!size.ok) return size
  const type = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
  if (!type) return { ok: false, message: `“${file.name}” is not a ${TYPE_LABEL} image. Other formats, including SVG and GIF, are not supported.` }
  let dims: { width: number; height: number }
  try {
    dims = await decodeImage(new Blob([file], { type }))
  } catch {
    return { ok: false, message: `“${file.name}” could not be decoded as an image; it may be damaged.` }
  }
  const px = checkImageSize(dims.width, dims.height)
  if (!px.ok) return px
  return { ok: true, blob: new Blob([file], { type }), type, name: file.name, ...dims }
}
