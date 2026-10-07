import { sanitizeSvg, parseSvgDocument } from '../svg/sanitize'
import { canonicalizeSvg } from '../svg/canonicalize'
import type { PngExportOptions, PngExportResult, SvgExportResult } from '../types'

/**
 * R4 export service. SVG export re-runs the fail-closed pipeline over the
 * current editor serialization so exported files carry no external runtime
 * dependencies. PNG export rasterizes the sanitized document via an
 * injectable rasterizer (jsdom tests supply a fake; the browser impl uses
 * Image + canvas).
 */

const DRAWABLE = /<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/i

export const MIN_PNG_WIDTH = 16
export const MAX_PNG_WIDTH = 8192
export const MIN_PNG_SCALE = 0.25
export const MAX_PNG_SCALE = 4
export const DEFAULT_PNG_TIMEOUT_MS = 10_000
/** Total canvas pixels the rasterizer may ever allocate. */
export const MAX_PNG_PIXELS = 64_000_000

export function clampPngWidth(width: number): number {
  if (!Number.isFinite(width)) return 640
  return Math.min(MAX_PNG_WIDTH, Math.max(MIN_PNG_WIDTH, Math.round(width)))
}

export function clampPngScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_PNG_SCALE, Math.max(MIN_PNG_SCALE, scale))
}

/**
 * Bound both output axes and the total pixel count, preserving aspect ratio.
 * Bounding width alone is not enough: a tall viewBox derives an unbounded
 * height and would attempt a multi-gigapixel canvas allocation (audit A5).
 */
export function clampOutputSize(width: number, height: number): { width: number; height: number } {
  let w = Math.max(1, Math.round(width))
  let h = Math.max(1, Math.round(height))
  const dimScale = Math.min(1, MAX_PNG_WIDTH / w, MAX_PNG_WIDTH / h)
  w = Math.max(1, Math.round(w * dimScale))
  h = Math.max(1, Math.round(h * dimScale))
  const pixelScale = Math.min(1, Math.sqrt(MAX_PNG_PIXELS / (w * h)))
  w = Math.max(1, Math.round(w * pixelScale))
  h = Math.max(1, Math.round(h * pixelScale))
  return { width: w, height: h }
}

export type Rasterizer = (
  svg: string,
  width: number,
  height: number,
  background: string | null
) => Promise<Blob>

export function exportSvgDocument(rawSvg: string): SvgExportResult {
  const result = sanitizeSvg(rawSvg)
  if (!result.ok || !result.svg) {
    return { ok: false, error: result.error ?? 'SVG rejected by sanitizer' }
  }
  try {
    const svg = canonicalizeSvg(result.svg)
    if (!DRAWABLE.test(svg)) {
      return { ok: false, error: 'The artwork has no drawable elements to export' }
    }
    return { ok: true, svg }
  } catch (e) {
    return { ok: false, error: `Failed to process SVG: ${(e as Error).message}` }
  }
}

/** Intrinsic size of the document, falling back to the viewBox, then 640x480. */
function intrinsicSize(root: SVGSVGElement): { width: number; height: number } {
  const attrSize = (name: string): number | null => {
    const v = root.getAttribute(name)
    // Only unitless or px lengths define a pixel size; "100%", em, etc. do not.
    const m = v ? /^([\d.]+)\s*(?:px)?$/i.exec(v.trim()) : null
    if (!m) return null
    const n = Number.parseFloat(m[1])
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const w = attrSize('width')
  const h = attrSize('height')
  if (w !== null && h !== null) return { width: w, height: h }
  const vb = root.getAttribute('viewBox')
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] }
    }
  }
  return { width: 640, height: 480 }
}

/** Intrinsic pixel dimensions of a document (width/height, else viewBox,
 * else null for unparseable input). Used for UI size previews and defaults. */
export function intrinsicDimensions(rawSvg: string): { width: number; height: number } | null {
  try {
    return intrinsicSize(parseSvgDocument(rawSvg))
  } catch {
    return null
  }
}

/** Intrinsic aspect (height/width) of a document for UI size previews. */
export function intrinsicAspectRatio(rawSvg: string): number | null {
  const dims = intrinsicDimensions(rawSvg)
  return dims ? dims.height / dims.width : null
}

/** Serialize the sanitized document with explicit pixel dimensions applied.
 * A document without a viewBox does not scale when resized — its user units
 * stay at 1:1 px and content outside the new viewport is cropped. Injecting
 * a viewBox derived from the current intrinsic size makes the resize scale
 * the whole artwork; rendering at the original size is unchanged. */
function withPixelSize(svg: string, width: number, height: number): string {
  const root = parseSvgDocument(svg)
  if (!root.getAttribute('viewBox')) {
    const intrinsic = intrinsicSize(root)
    root.setAttribute('viewBox', `0 0 ${intrinsic.width} ${intrinsic.height}`)
  }
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  return new XMLSerializer().serializeToString(root)
}

export async function exportPngDocument(
  rawSvg: string,
  options: PngExportOptions,
  deps: { rasterize?: Rasterizer } = {}
): Promise<PngExportResult> {
  const svgResult = exportSvgDocument(rawSvg)
  if (!svgResult.ok) return { ok: false, error: svgResult.error }

  const width = clampPngWidth(options.width)
  const scale = clampPngScale(options.scale)
  const timeoutMs = options.timeoutMs ?? DEFAULT_PNG_TIMEOUT_MS

  let root: SVGSVGElement
  try {
    root = parseSvgDocument(svgResult.svg)
  } catch {
    return { ok: false, error: 'Failed to parse the artwork for PNG export' }
  }
  const intrinsic = intrinsicSize(root)
  const aspect = intrinsic.height / intrinsic.width
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return { ok: false, error: 'The artwork has invalid dimensions for PNG export' }
  }
  // Clamp the final output size on both axes (not just the base width) so no
  // export can exceed the per-axis or total-pixel allocation budget.
  const targetWidth = Math.max(1, Math.min(MAX_PNG_WIDTH, Math.round(width * scale)))
  const size = clampOutputSize(targetWidth, targetWidth * aspect)
  const scaled = withPixelSize(svgResult.svg, size.width, size.height)

  const rasterize = deps.rasterize ?? browserRasterize
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error('timeout'))
    }, timeoutMs)
  })
  try {
    const blob = await Promise.race([rasterize(scaled, size.width, size.height, options.background), deadline])
    return { ok: true, blob, width: size.width, height: size.height }
  } catch (e) {
    return {
      ok: false,
      error: timedOut
        ? `PNG export timed out after ${Math.round(timeoutMs / 1000)}s`
        : `PNG export failed: ${(e as Error).message}`,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser default: Blob URL -> Image.decode() -> canvas -> PNG blob. */
const browserRasterize: Rasterizer = (svg, width, height, background) =>
  new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas 2D context unavailable')
        if (background !== null) {
          ctx.fillStyle = background
          ctx.fillRect(0, 0, width, height)
        }
        ctx.drawImage(image, 0, 0, width, height)
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('canvas encoding failed'))
        }, 'image/png')
      } catch (e) {
        reject(e as Error)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('the artwork could not be rendered as an image'))
    }
    image.src = url
  })

/** Writes clipboard items through the async Clipboard API. */
export type ClipboardWrite = (items: ClipboardItem[]) => Promise<void>

/** Wraps a (possibly still pending) PNG blob as a clipboard item. */
type ClipboardItemFactory = (blob: Promise<Blob>) => ClipboardItem

const browserClipboardItemFactory: ClipboardItemFactory = (blob) =>
  new ClipboardItem({ 'image/png': blob })

const browserClipboardWrite: ClipboardWrite = (items) => navigator.clipboard.write(items)

/**
 * Copies the artwork to the clipboard as a PNG image. Rasterization is
 * asynchronous while clipboard writes are only permitted inside the user
 * activation window, so the write starts immediately and the blob is handed
 * over as a promise (supported by Chromium and Safari). The call must reach
 * the write synchronously from the click handler.
 */
export async function copyPngToClipboard(
  rawSvg: string,
  options: PngExportOptions,
  deps: { rasterize?: Rasterizer; write?: ClipboardWrite; makeItem?: ClipboardItemFactory } = {}
): Promise<PngExportResult> {
  // Fail fast on sanitize errors without touching the clipboard.
  const svgResult = exportSvgDocument(rawSvg)
  if (!svgResult.ok) return { ok: false, error: svgResult.error }

  const resultPromise = exportPngDocument(rawSvg, options, { rasterize: deps.rasterize })
  // A rejected blob fails the clipboard write; exportPngDocument itself
  // always resolves and carries the structured pipeline error instead.
  const blobPromise = resultPromise.then((r) => (r.ok ? r.blob : Promise.reject(new Error(r.error))))

  try {
    const makeItem = deps.makeItem ?? browserClipboardItemFactory
    const write = deps.write ?? browserClipboardWrite
    await write([makeItem(blobPromise)])
  } catch (e) {
    // The write can reject either because the clipboard denied it or because
    // the blob pipeline failed; prefer the pipeline's precise error message.
    const r = await resultPromise
    return r.ok ? { ok: false, error: `Clipboard write failed: ${(e as Error).message}` } : r
  }
  return await resultPromise
}

/** File-name-safe project-name prefix; "snaplot" when no usable name. */
function fileNamePrefix(name: string | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  return cleaned || 'snaplot'
}

/** Timestamped download file name, e.g. Sunset-poster-20260825-142530.svg. */
export function buildFileName(
  kind: 'svg' | 'png',
  opts: { name?: string; now?: Date } = {}
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = opts.now ?? new Date()
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${fileNamePrefix(opts.name)}-${stamp}.${kind}`
}
