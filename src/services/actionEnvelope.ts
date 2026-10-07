import { extractFencedBlock, extractSvg } from '../svg/extract'

/**
 * Unified action envelope for the agent turn workflow. Every model reply is
 * parsed into exactly one action; the fenced-block contracts (```svg,
 * ```snaplot-edits, ```snaplot-choices) are kept as a legacy fallback so
 * providers still emitting the old format keep working.
 */

export type AgentAction =
  | { action: 'plan'; steps: { id: string; label: string }[] }
  /** projectName is the optional build_svg title applied to the project on the first build. */
  | { action: 'build'; svg: string; projectName?: string }
  | { action: 'edit'; operations: unknown }
  | { action: 'question'; questionId: string; prompt: string; choices: { id: string; label: string }[] }
  | { action: 'report'; summary: string; changes: string[] }
  | { action: 'unknown' }

export type EnvelopeStatus =
  | { kind: 'ok'; action: AgentAction }
  /** No envelope found anywhere in the reply. */
  | { kind: 'absent' }
  /** An envelope-looking block exists but could not be parsed. */
  | { kind: 'malformed'; reason: string }

// Only the explicit snaplot-action fence is an envelope. A bare ```json fence
// is usually unrelated example output in the model's explanation, so it must
// not count as (or fail as) an envelope here; parseReply performs a separate
// strict rescue for bare json blocks that parse into a recognized action.
const ENVELOPE_LANGS = ['snaplot-action'] as const

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseEnvelopeObject(obj: Record<string, unknown>): AgentAction | null {
  const action = asString(obj.action)
  switch (action) {
    case 'plan':
      if (!Array.isArray(obj.steps)) return null
      return {
        action: 'plan',
        steps: obj.steps.map((s) => {
          const o = (s ?? {}) as Record<string, unknown>
          return { id: asString(o.id), label: asString(o.label) }
        }),
      }
    case 'build':
      if (typeof obj.svg !== 'string') return null
      return { action: 'build', svg: obj.svg }
    case 'edit':
      if (!Array.isArray(obj.operations)) return null
      return { action: 'edit', operations: { operations: obj.operations } }
    case 'question':
      if (!Array.isArray(obj.choices)) return null
      return {
        action: 'question',
        questionId: asString(obj.questionId) || 'q',
        prompt: asString(obj.prompt),
        choices: obj.choices.map((c) => {
          const o = (c ?? {}) as Record<string, unknown>
          return { id: asString(o.id), label: asString(o.label) }
        }),
      }
    case 'report':
      if (typeof obj.summary !== 'string') return null
      return {
        action: 'report',
        summary: obj.summary,
        changes: Array.isArray(obj.changes) ? obj.changes.map(asString) : [],
      }
    default:
      return null
  }
}

/**
 * Parse one envelope JSON payload into an action. Recovers the companion
 * ```svg build form: {"action":"build"} without an inline svg plus a fenced
 * SVG elsewhere in the reply.
 */
function parseEnvelopePayload(text: string, obj: Record<string, unknown>): AgentAction | null {
  const parsed = parseEnvelopeObject(obj)
  if (parsed) return parsed
  if (obj.action === 'build' && typeof obj.svg !== 'string') {
    const svg = extractSvg(text)
    if (svg !== null) return { action: 'build', svg }
  }
  return null
}

/** Extract and validate the first ```snaplot-action envelope. */
export function parseActionEnvelope(text: string): EnvelopeStatus {
  for (const lang of ENVELOPE_LANGS) {
    const raw = extractFencedBlock(text, lang)
    if (raw === null) continue
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      const parsed = parseEnvelopePayload(text, obj)
      if (parsed) return { kind: 'ok', action: parsed }
      return { kind: 'malformed', reason: `invalid ${lang} envelope: unknown action or missing fields` }
    } catch (e) {
      return { kind: 'malformed', reason: `invalid JSON in ${lang} block: ${(e as Error).message}` }
    }
  }
  return { kind: 'absent' }
}

/** Legacy fenced-block fallback: map the old contracts onto actions. */
export function parseLegacyAction(text: string): EnvelopeStatus {
  // ```snaplot-edits → edit
  const edits = extractFencedBlock(text, 'snaplot-edits')
  if (edits !== null) {
    try {
      const obj = JSON.parse(edits) as Record<string, unknown>
      if (Array.isArray(obj.operations)) return { kind: 'ok', action: { action: 'edit', operations: obj } }
      return { kind: 'malformed', reason: 'invalid snaplot-edits block: operations array missing' }
    } catch (e) {
      return { kind: 'malformed', reason: `invalid JSON in snaplot-edits block: ${(e as Error).message}` }
    }
  }
  // ```snaplot-choices → question
  const choices = extractFencedBlock(text, 'snaplot-choices')
  if (choices !== null) {
    try {
      const obj = JSON.parse(choices) as Record<string, unknown>
      if (!Array.isArray(obj.choices)) return { kind: 'malformed', reason: 'invalid snaplot-choices block: choices array missing' }
      return {
        kind: 'ok',
        action: {
          action: 'question',
          questionId: asString(obj.questionId) || 'q',
          prompt: asString(obj.prompt),
          choices: obj.choices.map((c) => {
            const o = (c ?? {}) as Record<string, unknown>
            return { id: asString(o.id), label: asString(o.label) }
          }),
        },
      }
    } catch (e) {
      return { kind: 'malformed', reason: `invalid JSON in snaplot-choices block: ${(e as Error).message}` }
    }
  }
  // ```svg → build
  const svg = extractSvg(text)
  if (svg !== null) return { kind: 'ok', action: { action: 'build', svg } }
  return { kind: 'absent' }
}

/**
 * Rescue a bare ```json fence holding a full action payload — a common
 * provider slip. Only dispatched when no ```snaplot-action envelope exists at
 * all, and only when the JSON parses into a recognized action, so example
 * snippets in explanations never count as malformed.
 */
function rescueBareJsonEnvelope(text: string): AgentAction | null {
  const raw = extractFencedBlock(text, 'json')
  if (raw === null) return null
  try {
    return parseEnvelopePayload(text, JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return null
  }
}

/**
 * Primary entry: envelope first, tolerant recovery second. A malformed
 * envelope does not discard a usable payload elsewhere in the reply (e.g.
 * broken envelope JSON next to a valid ```svg fence); the legacy blocks and
 * the bare-json rescue run before a failure verdict is returned.
 */
export function parseReply(text: string): EnvelopeStatus {
  const envelope = parseActionEnvelope(text)
  if (envelope.kind === 'ok') return envelope
  const legacy = parseLegacyAction(text)
  if (legacy.kind === 'ok') return legacy
  if (envelope.kind === 'absent') {
    const rescued = rescueBareJsonEnvelope(text)
    if (rescued) return { kind: 'ok', action: rescued }
  }
  return envelope.kind === 'malformed' ? envelope : legacy
}
