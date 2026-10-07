import type { ChatMessage, PlanStep } from '../types'

/** Context budgets (see docs/build-plan.md, "Agent Turn Workflow"). */
export const SVG_MAX_BYTES = 100_000
export const HISTORY_MAX_MESSAGES = 20
export const SELECTION_SNIPPET_MAX_CHARS = 400

/**
 * Agent turn stages. The runner drives an explicit state machine
 * (UNDERSTAND → PLAN → AWAIT_CONFIRM → IMPLEMENT → VERIFY → REPORT);
 * prompts are built per stage instead of per inferred "mode".
 */
export type Stage = 'plan' | 'implement'

export interface PromptContext {
  stage: Stage
  history: ChatMessage[]
  currentSvg: string | null
  selection: { id: string | null; tagName: string; attributes: Record<string, string> } | null
  attributeValues: Record<string, string | number | boolean>
  /**
   * True when the user's message is feedback on an already proposed plan
   * (a plan is pending and unconfirmed). Switches the plan directive to a
   * revision variant so the model revises instead of re-planning.
   */
  planRevision?: boolean
  /**
   * User-adjusted steps (checklist edits applied, excluded steps dropped) of
   * the most recent plan, while the first artwork does not exist yet. Injected
   * as the revision baseline (plan stage) or the build list (implement stage).
   */
  planSteps?: PlanStep[] | null
  /**
   * One-line summary of the checklist edits (e.g. `skip "X"; change "Y" to
   * "Z"`), injected next to planSteps so the model sees adjustments by name.
   */
  planAdjustments?: string | null
}

/**
 * Field schema for edit operations. Single source of truth embedded in the
 * apply_edits tool description and in verify-retry feedback — without it the
 * model has to invent field names, which is the top source of rejected edits.
 */
export const EDIT_OPERATIONS_SCHEMA = `Every operation is a JSON object with a short "reason" string plus:
- {"type":"setRoot","reason":"...","attributes":{"width":"800","height":"600"}}
- {"type":"setAttributes","reason":"...","target":"el-3","attributes":{"fill":"#0a7"}}
- {"type":"insertElement","reason":"...","target":"el-3","position":"child|before|after","element":"<rect x=\\"10\\" y=\\"10\\" width=\\"5\\" height=\\"5\\" fill=\\"#333\\"/>"}
- {"type":"removeElement","reason":"...","target":"el-3"}
- {"type":"replaceElement","reason":"...","target":"el-3","element":"<circle cx=\\"5\\" cy=\\"5\\" r=\\"4\\"/>"}
- {"type":"setFullSvg","reason":"...","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>"}
"element" and "svg" MUST be JSON string values containing escaped XML markup (escape inner quotes as \\") — never a nested JSON object and never a differently named key. "position" is optional and defaults to "child".`

const ROLE = `You are Snaplot, an agent that creates and refines static SVG artwork. Each turn
you execute exactly ONE action: call exactly ONE of the available tools and accompany it with a
brief markdown explanation in the reply text (what you are doing, or what you changed).

Tool use rules:
- Exactly one tool call per reply. The tool arguments carry the action; the reply text is the
  user-facing explanation shown in chat.
- Operation shapes for apply_edits are documented on the tool description — follow them exactly.
- When a tool result reports errors, reply again with the corrected tool call. Never narrate the
  failed attempt or the correction in the reply text — it is user-facing, so describe only the
  change being made.
- Never echo the current artwork XML in your reply text.

Behavior rules:
- When artwork exists, treat EVERY user message as an EDIT instruction. Imperative statements
  like "make the background blue" or "make the title bigger" are edits — answer with apply_edits
  and explain the change in the reply text, never with text only.
- Never repeat artwork wholesale in a refinement; use targeted operations. setFullSvg (or a
  build_svg rebuild) only for a complete redesign.
- A confirmation like "yes, draw it", "go ahead", or "start drawing" always means: build now.
- Ask at most two clarifying questions total before the first artwork.
- Keep internal reasoning brief — a reply that produces only hidden reasoning, with no tool
  call and no reply text, is a failure.
- SVG must be safe static content: no scripts, no event handlers, no animation elements.
  Keep it compact (aim for fewer than 150 elements) — output that gets cut off cannot be used.
- Style with presentation attributes directly on elements (fill, stroke, font-family, opacity,
  ...). <style> blocks and CSS class rules are stripped before display — never use them.
- Images must be inline data: URIs; external http(s) URLs are stripped by verification. Web
  fonts do not load — use generic font families (sans-serif, serif, monospace).
- Write every user-facing string — reply text, ask_question prompts and choice labels,
  propose_plan steps, and the artwork "name" — in the same language as the user's messages.`

/** Stage directive placed at the very top so it cannot be missed. */
function stageDirective(ctx: PromptContext): string {
  if (ctx.stage === 'plan') {
    if (ctx.planRevision) {
      return (
        'STAGE: PLAN (REVISION) — You already proposed a plan (see conversation). The user ' +
          'message is feedback on that plan. Revise the plan: keep unchanged parts stable ' +
          '(reuse step ids and labels where unchanged), integrate the feedback, and call ' +
          'propose_plan again with the full updated steps array. If the message is a plain ' +
          'confirmation with no change requested, re-propose the same adjusted plan unchanged. ' +
          'The PLAN CHECKLIST context message is the authoritative baseline — the user\'s ' +
          'checklist edits are applied in it. Keep the step list out of the reply text; it ' +
          'renders as an interactive checklist. Only call ask_question if the feedback itself ' +
          'is materially ambiguous.'
      )
    }
    return (
      'STAGE: PLAN — No confirmed artwork yet. Present a concise design plan as markdown text ' +
        '(subject, composition/layout, color palette, style, canvas size) and call propose_plan ' +
        'with the drawing steps. Keep the step list out of the reply text; it renders as an ' +
        'interactive checklist. The user will confirm the plan before you build. Only if the ' +
        'request is materially ambiguous, call ask_question instead.'
    )
  }
  return (
    'STAGE: IMPLEMENT — Build or refine the artwork now. ' +
    (ctx.currentSvg
      ? 'Artwork exists: call apply_edits with operations that apply the user\'s instruction ' +
        '(empty operations is valid), or ask_question only if genuinely ambiguous. Explain the ' +
        'change briefly in the reply text.'
      : 'Call build_svg with the complete <svg> document and a short "name" field ' +
        '(2-6 word project title for the artwork, applied as the project name). ' +
        'Do not restate the plan.' +
        ((ctx.planSteps?.length ?? 0) > 0
          ? " Follow the CONFIRMED PLAN STEPS in the context messages exactly — it reflects the user's checklist adjustments."
          : ''))
  )
}

export function buildSystemPrompt(ctx: PromptContext): string {
  return [stageDirective(ctx), '', ROLE].join('\n')
}

/** Indent every line of an XML string by two spaces (fence-free embedding). */
function indentXml(xml: string): string {
  return xml
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')
}

/** Trim a serialized SVG to the byte budget, keeping it valid XML. */
export function boundSvg(svg: string, maxBytes = SVG_MAX_BYTES): string {
  if (svg.length <= maxBytes) return svg
  // Keep the document valid by closing the root element after truncation.
  const cut = svg.slice(0, maxBytes)
  const open = cut.match(/<svg[^>]*>/)
  const head = open ? cut.slice(0, open.index! + open[0].length) : '<svg xmlns="http://www.w3.org/2000/svg">'
  return head + '<!-- truncated --></svg>'
}

export function boundHistory(history: ChatMessage[]): ChatMessage[] {
  return history.slice(-HISTORY_MAX_MESSAGES)
}

export function selectionSnippet(
  selection: PromptContext['selection']
): string | null {
  if (!selection) return null
  const attrs = Object.entries(selection.attributes)
    .slice(0, 12)
    .map(([k, v]) => `${k}="${String(v).slice(0, 80)}"`)
    .join(' ')
  return `<${selection.tagName} ${attrs}/>`.slice(0, SELECTION_SNIPPET_MAX_CHARS)
}

export interface BuiltRequest {
  messages: ChatMessage[]
}

export function buildRequestMessages(ctx: PromptContext): BuiltRequest {
  const contextLines: string[] = []
  if (ctx.currentSvg) {
    // Embed the raw XML without fences so the model cannot mistake it for an
    // output template to echo back.
    contextLines.push(
      'CURRENT ARTWORK (authoritative, ids are stable targets for edit operations; ',
      'reference only — never echo this XML in your reply):',
      indentXml(boundSvg(ctx.currentSvg))
    )
  }
  if (ctx.selection?.id) {
    contextLines.push(
      `SELECTED ELEMENT: ${selectionSnippet(ctx.selection)}`,
      'The user has this element selected on the canvas; their message most likely asks to ' +
        'modify it. Prioritize this element when interpreting the instruction.'
    )
  }
  const attrEntries = Object.entries(ctx.attributeValues)
  if (attrEntries.length > 0) {
    contextLines.push(
      'ACTIVE ATTRIBUTE VALUES: ' +
        attrEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
    )
  }
  if (!ctx.currentSvg && ctx.planSteps && ctx.planSteps.length > 0) {
    const list = ctx.planSteps.map((s, i) => `${i + 1}. ${s.label}`).join('; ')
    const note = ctx.planAdjustments ? `\nChecklist adjustments: ${ctx.planAdjustments}.` : ''
    contextLines.push(
      ctx.stage === 'plan'
        ? `PLAN CHECKLIST (user-adjusted, authoritative baseline): ${list}${note}\n` +
            'The user edited your proposed steps via a checklist. Keep these steps and their ' +
            'labels unless the feedback changes them, and never reintroduce an excluded step. ' +
            'Return the full updated steps array via propose_plan.'
        : `CONFIRMED PLAN STEPS (overrides the step list in your earlier plan text): ${list}${note}\n` +
            'The user confirmed the plan with checklist edits applied. Build the artwork ' +
            'following exactly this list, in order — steps the user excluded must not appear ' +
            'in the artwork.'
    )
  }
  const history = boundHistory(ctx.history)
  if (history.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'))) {
    contextLines.push(
      'ATTACHED IMAGES: some user messages include attached reference images. Use them as a visual ' +
        'reference for subject, composition and style when the instruction refers to them. To copy ' +
        'or imitate an image, recreate its look with SVG shapes — never try to embed or link the bitmap.'
    )
  }

  const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx) }]
  if (contextLines.length > 0) {
    messages.push({ role: 'system', content: contextLines.join('\n') })
  }
  messages.push(...history)
  return { messages }
}
