export type FencedLang = 'svg' | 'snaplot-action' | 'snaplot-edits' | 'snaplot-choices' | 'snaplot-attributes' | 'json'

export type BlockStatus =
  | { kind: 'ok'; content: string }
  | { kind: 'absent' }
  /** A block with the right language exists but could not be parsed. */
  | { kind: 'malformed'; reason: string }

/**
 * Extract the first fenced code block with the given language tag.
 * Unterminated fences (truncated output) fall back to the remaining text so a
 * cut-off SVG is still recoverable.
 */
export function extractFencedBlock(text: string, lang: FencedLang): string | null {
  const open = new RegExp('```' + lang + '\\s*\\n', 'i')
  const openMatch = text.match(open)
  if (!openMatch) return null
  const start = openMatch.index! + openMatch[0].length
  const close = text.indexOf('\n```', start)
  if (close === -1) return text.slice(start).trim() // unterminated: truncated output
  return text.slice(start, close).trim()
}

/** Like extractFencedBlock but distinguishes absent from malformed. */
export function inspectFencedBlock(text: string, lang: FencedLang): BlockStatus {
  const open = new RegExp('```' + lang + '\\s*\\n', 'i')
  const openMatch = text.match(open)
  if (!openMatch) return { kind: 'absent' }
  const start = openMatch.index! + openMatch[0].length
  const close = text.indexOf('\n```', start)
  if (close === -1) return { kind: 'malformed', reason: 'the block was never closed (output truncated?)' }
  const content = text.slice(start, close).trim()
  if (!content) return { kind: 'malformed', reason: 'the block is empty' }
  return { kind: 'ok', content }
}

/** Pull a complete <svg>...</svg> document out of arbitrary text. */
function extractBareSvg(text: string): string | null {
  const m = text.match(/<svg[\s\S]*<\/svg>/i)
  return m ? m[0].trim() : null
}

export function extractSvg(text: string): string | null {
  // Preferred: a proper ```svg fence.
  const fenced = extractFencedBlock(text, 'svg')
  if (fenced) return fenced
  // Fallbacks for models that use alias languages or no fence at all.
  for (const alias of ['xml', 'html'] as const) {
    const open = new RegExp('```' + alias + '\\s*\\n', 'i')
    const openMatch = text.match(open)
    if (!openMatch) continue
    const start = openMatch.index! + openMatch[0].length
    const close = text.indexOf('\n```', start)
    const content = (close === -1 ? text.slice(start) : text.slice(start, close)).trim()
    if (/<svg[\s>]/i.test(content)) return extractBareSvg(content) ?? content
  }
  return extractBareSvg(text)
}

export function extractJson<T>(text: string, lang: FencedLang): T | null {
  const raw = extractFencedBlock(text, lang)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Like extractJson but distinguishes absent from malformed JSON. */
export function inspectJson<T>(text: string, lang: FencedLang): { status: BlockStatus; value: T | null } {
  const status = inspectFencedBlock(text, lang)
  if (status.kind !== 'ok') return { status, value: null }
  try {
    return { status, value: JSON.parse(status.content) as T }
  } catch (e) {
    return {
      status: { kind: 'malformed', reason: 'invalid JSON: ' + (e as Error).message },
      value: null,
    }
  }
}

/** Languages whose fenced blocks carry action payloads rather than prose. */
const FENCE_LANGS =
  'svg|xml|html|json|snaplot-action|snaplot-edits|snaplot-choices|snaplot-attributes'

/** A closed payload fence: opening marker through its closing marker. */
const CLOSED_FENCE = new RegExp(
  '```(?:' + FENCE_LANGS + ')[^\\n]*\\n[\\s\\S]*?\\n```[^\\n]*\\n?',
  'gi'
)

/**
 * A payload fence that was opened but never closed; it extends to the end of
 * the text (mid-stream delta or truncated output). Only meaningful after
 * CLOSED_FENCE has consumed the closed fences.
 */
const OPEN_FENCE_TAIL = new RegExp('```(?:' + FENCE_LANGS + ')[^\\n]*(?:\\n[\\s\\S]*)?$', 'i')

/** True while a payload fence is open (streaming) or was left open (truncated). */
export function hasOpenFence(text: string): boolean {
  return OPEN_FENCE_TAIL.test(text.replace(CLOSED_FENCE, ''))
}

/** Strip all snaplot fenced blocks from assistant text before chat display. */
export function stripFencedBlocks(text: string): string {
  return text
    .replace(CLOSED_FENCE, '')
    .replace(OPEN_FENCE_TAIL, '')
    .trim()
}
