import { streamChat } from './streamClient'
import { exportPngDocument, type Rasterizer } from './export'
import { blobToDataUrl } from './imageAttach'
import { beginTurnScope, turnScopeValid } from './turnScope'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chat'
import { useEditorStore } from '../stores/editor'
import type { ChatMessage, ContentPart } from '../types'

/**
 * Vision review: rasterize the current artwork and ask a vision-capable model
 * whether it matches the user's intent. Used automatically after artwork
 * changes (per the visualReviewMode setting) and via the manual button in the
 * chat panel. Review failures never throw — they degrade to a reported error.
 */

/** Width used for review screenshots; large enough for layout checks. */
export const REVIEW_IMAGE_WIDTH = 1024

/**
 * Prompt flavor: 'auto' is the lenient verify-loop gate (mechanical defects
 * only); 'manual' is the detailed critique behind the review button, adding
 * SVG technical-quality checks and fix suggestions.
 */
export type VisualReviewMode = 'auto' | 'manual'

const REVIEW_SYSTEM_PROMPT = `You are Snaplot's visual reviewer. You receive a rendered screenshot
of SVG artwork and the user's intent. Judge ONLY objective, mechanical defects visible in the
image: elements clipped by or outside the canvas, text overlapping other content so it cannot be
read, missing or garbled shapes, empty regions where content clearly should be, or a clear
mismatch against the stated intent.

Ignore font substitution, font weight, and antialiasing differences — the screenshot renders
with system fonts, so typeface aesthetics are not defects. Ignore matters of taste (color
preference, composition balance, style choices): when your only concerns are aesthetic, pass.

Reply with ONLY a fenced json block:
\`\`\`json
{"pass": true|false, "issues": ["short, concrete description", ...]}
\`\`\`
"pass" is true when the artwork reasonably matches the intent and has no obvious mechanical
defect. Each issue must name the element or region and a concrete fix; never mention things
that cannot be verified from the image. Write issues in the same language as the user's intent.`

const MANUAL_REVIEW_SYSTEM_PROMPT = `You are Snaplot's visual reviewer. You receive a rendered
screenshot of SVG artwork and the user's intent. This is a detailed manual review, so check
three groups of concerns visible in the image.

Mechanical defects: elements clipped by or outside the canvas, text overlapping other content
so it cannot be read, missing or garbled shapes, empty regions where content clearly should
be, or a clear mismatch against the stated intent.

Technical quality: misalignment (elements that should share an edge, axis, or center but do
not), unjustified inconsistency (stroke widths, corner radii, font sizes, or spacing rhythm
that vary without a visible reason), and poor canvas utilization (content occupying a small
fraction of the canvas, crowding the canvas edge with no safe margin, or overcrowding).

Design quality: weak visual hierarchy (no clear focal point or dominance), low contrast
between content and background, discordant or muddy color combinations, unbalanced
composition, and awkward spacing or grouping.

Ignore font substitution, font weight, and antialiasing differences — the screenshot renders
with system fonts, so typeface aesthetics are not defects.

Reply with ONLY a fenced json block:
\`\`\`json
{"pass": true|false, "issues": ["short, concrete description", ...],
 "suggestions": [{"id": "kebab-case-id", "label": "imperative fix instruction"}]}
\`\`\`
"pass" is true when the artwork reasonably matches the intent, has no obvious mechanical or
technical defect, and no severe design-quality flaw (anything that makes content hard to
read or the artwork hard to parse). Each issue must name the element or region and a concrete
fix; never mention things that cannot be verified from the image.

Then list the 3 to 5 most important improvement suggestions, ranked by impact — defects
first, design refinements after; prefer a few high-impact suggestions over many nitpicks.
Each label is a single imperative instruction a design agent could execute directly, such as
"Align the title to the canvas center axis". Include suggestions even when "pass" is true;
return an empty list only when the artwork truly leaves no room for improvement. Write issues
and suggestion labels in the same language as the user's intent.`

export interface ReviewSuggestion {
  id: string
  label: string
}

export interface VisualReviewResult {
  /** false when the request itself failed (render, network, unparsable reply). */
  ok: boolean
  pass?: boolean
  issues?: string[]
  /** Top improvement suggestions from a manual review; empty for auto reviews. */
  suggestions?: ReviewSuggestion[]
  error?: string
}

/** Render the artwork to a PNG data URL; null when rasterization fails. */
export async function renderReviewImage(
  svg: string,
  deps: { rasterize?: Rasterizer } = {}
): Promise<string | null> {
  const result = await exportPngDocument(
    svg,
    { width: REVIEW_IMAGE_WIDTH, scale: 1, background: '#ffffff' },
    deps
  )
  if (!result.ok) return null
  return await blobToDataUrl(result.blob)
}

/** Messages for a vision review request: instructions + screenshot. */
export function buildVisualReviewMessages(
  instruction: string,
  image: string,
  mode: VisualReviewMode = 'auto'
): ChatMessage[] {
  const system =
    mode === 'manual' ? MANUAL_REVIEW_SYSTEM_PROMPT : REVIEW_SYSTEM_PROMPT
  const text: ContentPart = {
    type: 'text',
    text:
      `Review the attached artwork screenshot.\nUser intent: ${instruction || '(general quality check)'}` +
      '\nReply with the fenced json verdict only.',
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: [{ type: 'text', text: text.text }, { type: 'image', image }] },
  ]
}

/** The prompt asks for the 3–5 highest-impact suggestions; the cap enforces the ceiling. */
const MAX_SUGGESTIONS = 5

/** Keep well-formed, uniquely identified suggestions, capped at the chip budget. */
function sanitizeSuggestions(raw: unknown): ReviewSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewSuggestion[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id.trim()) continue
    if (typeof o.label !== 'string' || !o.label.trim()) continue
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push({ id: o.id, label: o.label })
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/** Extract the first JSON object from a review reply; null when absent. */
export function parseReviewVerdict(
  reply: string
): { pass: boolean; issues: string[]; suggestions: ReviewSuggestion[] } | null {
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : reply
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      pass?: unknown
      issues?: unknown
      suggestions?: unknown
    }
    if (typeof parsed.pass !== 'boolean') return null
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((i): i is string => typeof i === 'string' && i.trim() !== '')
      : []
    return { pass: parsed.pass, issues, suggestions: sanitizeSuggestions(parsed.suggestions) }
  } catch {
    return null
  }
}

/**
 * Run one visual review of `svg`. Never throws; request failures come back as
 * `{ ok: false, error }` so the caller can degrade gracefully.
 * `registerCancel` receives the review stream's cancel handle while the
 * request is in flight and null once it settles, so the chat store's Stop
 * control can abort the review too.
 */
export async function runVisualReview(
  svg: string,
  instruction: string,
  deps: {
    rasterize?: Rasterizer
    mode?: VisualReviewMode
    registerCancel?: (cancel: (() => void) | null) => void
  } = {}
): Promise<VisualReviewResult> {
  const image = await renderReviewImage(svg, deps)
  if (!image) {
    return { ok: false, error: 'the artwork could not be rendered for visual review' }
  }
  const settings = useSettingsStore.getState()
  const handle = streamChat(
    {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.visionModel || settings.model,
      messages: buildVisualReviewMessages(instruction, image, deps.mode ?? 'auto'),
    },
    () => {}
  )
  deps.registerCancel?.(handle.cancel)
  let full: string
  try {
    const result = await handle.promise
    full = result.text
  } catch (e) {
    deps.registerCancel?.(null)
    return { ok: false, error: (e as Error).message }
  }
  deps.registerCancel?.(null)
  const verdict = parseReviewVerdict(full)
  if (!verdict) {
    return { ok: false, error: 'the vision model returned no parsable verdict' }
  }
  return { ok: true, pass: verdict.pass, issues: verdict.issues, suggestions: verdict.suggestions }
}

/**
 * Manual review entry point (the ChatPanel button): reviews the current
 * artwork with the detailed critique prompt and renders the verdict as a
 * normal assistant message. The model's top improvement suggestions attach as
 * choice chips — clicking one sends it as the next instruction. Fire-and-
 * forget like sendChatMessage — never throws.
 */
export async function sendVisualReviewTurn(deps: { rasterize?: Rasterizer } = {}): Promise<void> {
  // Review the live canvas, not a pre-debounce snapshot of it.
  useEditorStore.getState().flushLiveCanvas()
  const chat = useChatStore.getState()
  const settings = useSettingsStore.getState()
  const svg = useEditorStore.getState().currentSvg
  if (chat.status === 'streaming' || chat.status === 'canceled') return
  if (!svg) {
    chat.setStatus('error', 'No artwork to review yet')
    return
  }
  if (!settings.baseUrl || !settings.model) {
    chat.setStatus('error', 'Provider is not configured — set Base URL and Model in Settings')
    return
  }
  const scope = beginTurnScope()
  const instruction = latestUserInstruction()
  const assistantId = chat.beginAssistant()
  const result = await runVisualReview(svg, instruction, {
    ...deps,
    mode: 'manual',
    // Keep the review abortable from the chat panel's Stop control.
    registerCancel: (cancel) => useChatStore.getState().setCancel(cancel),
  })
  // The project changed or the user cancelled while the review ran — end the
  // placeholder quietly instead of appending into a foreign conversation.
  if (!turnScopeValid(scope) || useChatStore.getState().status === 'canceled') {
    useChatStore.getState().interruptAssistant(assistantId)
    return
  }
  const markdown = formatReviewReport(result)
  useChatStore.getState().appendAssistantDelta(assistantId, markdown)
  if (result.ok && (result.suggestions?.length ?? 0) > 0) {
    useChatStore.getState().setAssistantPayload(assistantId, { chips: result.suggestions })
  }
  useChatStore.getState().finishAssistant(assistantId)
}

function latestUserInstruction(): string {
  const messages = useChatStore.getState().messages
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].text
  }
  return ''
}

function formatReviewReport(result: VisualReviewResult): string {
  if (!result.ok) return `**Visual review failed** — ${result.error}`
  if (result.pass) return '**Visual review: passed.** The artwork matches the intent with no obvious visual defects.'
  const issues = (result.issues ?? []).map((i) => `- ${i}`).join('\n')
  return `**Visual review: found issues.**\n${issues || '- (no details provided)'}`
}
