import { sanitizeSvg } from './sanitize'
import { assignStableIds } from './ids'
import { canonicalizeSvg } from './canonicalize'
import { applyEditOperations } from './edits'

/**
 * VERIFY stage of the agent turn: all programmatic checks live here so the
 * runner only ever consumes structured results. Each check returns a list of
 * deterministic errors that are fed back into the retry loop verbatim.
 */

export const MAX_ELEMENTS = 400
export const MAX_BYTES = 200_000

const DRAWABLE = /<(?:path|rect|circle|ellipse|line|polyline|polygon|text|image|use)\b/i

const utf8Encoder = new TextEncoder()

/** Size in UTF-8 bytes — string .length under-counts multibyte content up to 3x. */
function byteLength(svg: string): number {
  return utf8Encoder.encode(svg).length
}

/**
 * Budget checks over a final (sanitized + id'd + canonicalized) document.
 * Shared by build and edit verification so the edit path cannot deliver a
 * document the build path would reject (audit A4).
 */
function budgetErrors(finalSvg: string): string[] {
  const errors: string[] = []
  const bytes = byteLength(finalSvg)
  if (bytes > MAX_BYTES) {
    errors.push(`SVG exceeds the ${MAX_BYTES} byte budget (${bytes} bytes)`)
  }
  const elementCount = (finalSvg.match(/<[a-zA-Z]/g) ?? []).length
  if (elementCount > MAX_ELEMENTS) {
    errors.push(`SVG exceeds the ${MAX_ELEMENTS} element budget (${elementCount} elements)`)
  }
  return errors
}

export interface VerifyResult {
  ok: boolean
  /** Verified artwork, sanitized + stable-id'd + canonicalized. */
  svg: string | null
  errors: string[]
}

/** Full-pipeline check for a newly built SVG document. */
export function verifySvgBuild(raw: string): VerifyResult {
  const result = sanitizeSvg(raw)
  if (!result.ok || !result.svg) {
    return { ok: false, svg: null, errors: [result.error ?? 'SVG rejected by sanitizer'] }
  }
  try {
    const { svg: withIds } = assignStableIds(result.svg)
    const finalSvg = canonicalizeSvg(withIds)
    const errors: string[] = []
    if (!DRAWABLE.test(finalSvg)) {
      errors.push(
        result.removedElements.length > 0
          ? `SVG has no drawable elements (removed unsupported: ${result.removedElements.join(', ')})`
          : 'SVG has no drawable elements'
      )
    }
    errors.push(...budgetErrors(finalSvg))
    if (errors.length > 0) return { ok: false, svg: null, errors }
    return { ok: true, svg: finalSvg, errors: [] }
  } catch (e) {
    return { ok: false, svg: null, errors: [`Failed to process SVG: ${(e as Error).message}`] }
  }
}

/** Check + apply a batch of edit operations against the current artwork. */
export function verifyEdits(currentSvg: string | null, payload: unknown): VerifyResult {
  if (!currentSvg) {
    return { ok: false, svg: null, errors: ['no artwork is loaded — deliver a complete new artwork instead'] }
  }
  const result = applyEditOperations(currentSvg, payload)
  if (!result.ok || !result.svg) {
    return { ok: false, svg: null, errors: result.errors }
  }
  try {
    const { svg: withIds } = assignStableIds(result.svg)
    const finalSvg = canonicalizeSvg(withIds)
    // Same final-document contract as builds: an edit batch must not deliver a
    // document that build verification would reject (budgets, drawability).
    const errors: string[] = []
    if (!DRAWABLE.test(finalSvg)) {
      errors.push('SVG has no drawable elements')
    }
    errors.push(...budgetErrors(finalSvg))
    if (errors.length > 0) return { ok: false, svg: null, errors }
    return { ok: true, svg: finalSvg, errors: [] }
  } catch (e) {
    return { ok: false, svg: null, errors: [`Failed to process edit result: ${(e as Error).message}`] }
  }
}
