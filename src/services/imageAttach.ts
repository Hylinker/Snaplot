/**
 * Attachment normalization for chat image uploads. Uploaded files become base64
 * data URLs ready to send as multimodal content parts: small files in supported
 * formats pass through untouched (preserving transparency and animation);
 * larger ones are downscaled and re-encoded as JPEG so requests stay well
 * inside the dev proxy's 10 MB body cap.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 4

/** Files up to this size are sent exactly as uploaded. */
export const PASS_THROUGH_MAX_BYTES = 512 * 1024

/** Hard rejection limit, before any decoding happens. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/** Longest edge of re-encoded images. */
export const MAX_IMAGE_EDGE = 1024

export const ACCEPTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** `accept` attribute for the composer's hidden file input. */
export const ATTACH_ACCEPT = ACCEPTED_IMAGE_MIME.join(',')

export type NormalizeImageResult = { ok: true; dataUrl: string } | { ok: false; error: string }

/** Decodes a file and returns a downscaled JPEG data URL; null on failure. */
export type ImageReencoder = (file: File) => Promise<string | null>

export function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/** Default browser re-encode: decode → canvas (bounded edge, white matte) → JPEG. */
const browserReencode: ImageReencoder = async (file) => {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => resolve(null)
      el.src = url
    })
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Flatten transparency onto white so JPEG re-encoding has no black fringes.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function normalizeImageFile(
  file: File,
  deps: { reencode?: ImageReencoder } = {}
): Promise<NormalizeImageResult> {
  if (!(ACCEPTED_IMAGE_MIME as readonly string[]).includes(file.type)) {
    return { ok: false, error: 'Unsupported image format — use PNG, JPEG, WebP or GIF' }
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `Image is too large — the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`,
    }
  }
  if (file.size <= PASS_THROUGH_MAX_BYTES) {
    const dataUrl = await blobToDataUrl(file)
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'The image could not be read' }
  }
  const dataUrl = await (deps.reencode ?? browserReencode)(file)
  return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'The image could not be processed' }
}
