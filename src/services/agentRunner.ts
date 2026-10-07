import { streamChat, isEmptyResponseError, type StreamResult } from './streamClient'
import { buildRequestMessages, type PromptContext, type Stage } from './promptBuilder'
import {
  actionFromToolCall,
  toolsForStage,
  toolResultOutput,
  type ToolResultPayload,
} from './agentTools'
import { useChatStore, annotatePlanSteps, findLatestPlan } from '../stores/chat'
import { useEditorStore } from '../stores/editor'
import { useSettingsStore } from '../stores/settings'
import { DEFAULT_PROJECT_NAME, useProjectsStore } from '../stores/projects'
import { beginTurnScope, turnScopeValid, type TurnScope } from './turnScope'
import { canonicalizeSvg } from '../svg/canonicalize'
import { verifyEdits, verifySvgBuild } from '../svg/verify'
import { runVisualReview } from './visionReview'
import { planAdjustmentNote } from './planSteps'
import type { ChatMessage, ToolCall } from '../types'

/**
 * Agent turn workflow: each user message runs an explicit state machine
 *
 *   UNDERSTAND → PLAN → AWAIT_CONFIRM → IMPLEMENT → VERIFY → REPORT
 *        ↑                                            │
 *        └──── (verify failure: tool-result feedback, ≤ MAX_RETRIES) ────┘
 *
 * UNDERSTAND is the context assembly below; PLAN/AWAIT_CONFIRM apply before
 * the first artwork (the plan gates the first build); VERIFY consumes the
 * structured checks in svg/verify.ts. Actions arrive as native tool calls;
 * a rejected action is fed back as a tool-result message appended to the
 * conversation, so the model always sees its own failed attempt.
 */

const MAX_RETRIES = 2

/** Cap for the reply text kept in retry transcript entries. */
const RETRY_EXCERPT_MAX_CHARS = 4000

/** Bound the reply text so retries stay inside token budgets. */
function boundReply(reply: string): string {
  if (reply.length <= RETRY_EXCERPT_MAX_CHARS) return reply
  return reply.slice(0, RETRY_EXCERPT_MAX_CHARS) + '\n…(truncated)'
}

/**
 * Chat orchestration entry point: assembles the prompt from current state,
 * streams the response through the dev proxy, routes the model's tool call
 * through the verify pipeline, and updates editor + chat state.
 * Components never call the provider directly.
 */
export async function sendChatMessage(text: string, images: string[] = []): Promise<void> {
  // The live canvas is authoritative: flush any debounced manual write-back
  // first so the turn sees the user's latest edits (and their stable ids).
  useEditorStore.getState().flushLiveCanvas()
  const chat = useChatStore.getState()
  const editor = useEditorStore.getState()
  const settings = useSettingsStore.getState()

  // 'canceled' is the brief window while an aborted stream is still settling.
  if (chat.status === 'streaming' || chat.status === 'canceled') return
  if (!settings.baseUrl || !settings.model) {
    // Graceful failure instead of a throw: callers dispatch this fire-and-forget,
    // so a synchronous throw would surface as an unhandled rejection.
    chat.setStatus('error', 'Provider is not configured — set Base URL and Model in Settings')
    return
  }

  chat.appendUser(
    text,
    editor.selection?.id ? { id: editor.selection.id, tagName: editor.selection.tagName } : null,
    images.length > 0 ? images : undefined
  )
  const assistantId = chat.beginAssistant()

  // The editor revision is authoritative — never reconstruct SVG from chat.
  const currentSvg = editor.currentSvg ? canonicalizeSvg(editor.currentSvg) : null
  // Snapshot the pre-turn canvas so the reply can be withdrawn later.
  chat.setSvgBefore(assistantId, currentSvg)

  // UNDERSTAND: decide the entry stage of the state machine. Existing artwork
  // means every instruction is an edit; otherwise a confirmed plan is required
  // before the first build (the AWAIT_CONFIRM gate).
  const stage: Stage = resolveStage(currentSvg)

  // A pending plan makes this turn either a revision (user text feedback) or
  // the confirmed build; the user-adjusted step list feeds both prompts. The
  // derivation uses persisted messages, so it survives reloads.
  const pendingPlan = currentSvg ? null : findLatestPlan(chat.messages)
  const planSteps = pendingPlan
    ? annotatePlanSteps(
        pendingPlan.planSteps ?? [],
        useChatStore.getState().planStepEdits
      ).filter((s) => s.included)
    : []
  const planAdjustments = pendingPlan
    ? planAdjustmentNote(pendingPlan.planSteps ?? [], useChatStore.getState().planStepEdits)
    : null

  const history = useHistory()

  useChatStore.getState().setTurnStage(stage === 'plan' ? 'plan' : 'implement')

  // Bind the turn to the active project: every continuation re-checks the
  // scope before writing to stores, so a mid-turn switch/create/delete can
  // never land this turn's state in a different project (audit A1).
  const scope = beginTurnScope()

  await runTurn(
    assistantId,
    {
      stage,
      history,
      currentSvg,
      selection: editor.selection,
      attributeValues: useChatStore.getState().attributeValues,
      planRevision: stage === 'plan' && pendingPlan !== null,
      ...(planSteps.length > 0 ? { planSteps } : {}),
      ...(planAdjustments !== null ? { planAdjustments } : {}),
    },
    0,
    [],
    scope
  )
}

function resolveStage(currentSvg: string | null): Stage {
  if (currentSvg) return 'implement'
  return useChatStore.getState().planConfirmed ? 'implement' : 'plan'
}

/** How many recent image-bearing user messages keep their images in requests. */
const IMAGE_HISTORY_MESSAGES = 2

const IMAGE_OMITTED_NOTE = '(reference image omitted)'

export function useHistory(): PromptContext['history'] {
  // appendUser(text) has already run, so the new user message is included once.
  const messages = useChatStore
    .getState()
    .messages.filter((m) => !m.streaming && (m.role === 'user' || m.raw))
  // Images ride along only for the newest image-bearing turns so requests stay
  // well inside the proxy's 10 MB body cap; older images degrade to a note.
  const recentImageIds = new Set(
    messages
      .filter((m) => m.role === 'user' && (m.images?.length ?? 0) > 0)
      .slice(-IMAGE_HISTORY_MESSAGES)
      .map((m) => m.id)
  )
  return messages.map((m) => {
    if (m.role !== 'user' || !m.images?.length) {
      return { role: m.role, content: m.raw ?? m.text }
    }
    if (!recentImageIds.has(m.id)) {
      return { role: m.role, content: `${m.text} ${IMAGE_OMITTED_NOTE}`.trim() }
    }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.text || '(image attached)' },
        ...m.images.map((image) => ({ type: 'image' as const, image })),
      ],
    }
  })
}

/** Conversation transcript entry for one failed tool-call attempt. */
function toolAttemptMessages(text: string, call: ToolCall, output: ToolResultPayload): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        ...(text.trim()
          ? [{ type: 'text' as const, text: boundReply(text) }]
          : []),
        { type: 'tool-call' as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: toolResultOutput(output),
        },
      ],
    },
  ]
}

/** Conversation transcript entry for a text-only reply that must call a tool. */
function textOnlyAttemptMessages(text: string, nudge: string): ChatMessage[] {
  return [
    { role: 'assistant', content: boundReply(text) },
    { role: 'user', content: nudge },
  ]
}

/**
 * Conversation transcript entry for a reasoning-only reply: the failed attempt
 * produced no visible output, so it is represented by an explicit placeholder
 * (keeping user/assistant alternation) followed by the corrective nudge.
 */
function emptyResponseAttemptMessages(): ChatMessage[] {
  return [
    { role: 'assistant', content: '(The previous reply contained only hidden reasoning and produced no visible output.)' },
    {
      role: 'user',
      content:
        'Your previous reply spent its output budget on internal reasoning with no visible ' +
        'output or tool call. Reply again: keep reasoning to a few short steps, then finish ' +
        'with exactly one tool call (or a brief text answer when artwork exists).',
    },
  ]
}

function toolNudge(ctx: PromptContext): string {
  if (ctx.stage === 'plan') {
    return (
      'Your previous reply called no tool. Reply again and call exactly one tool: ' +
        'propose_plan with the drawing steps (or ask_question if the request is materially ambiguous).'
    )
  }
  return (
    'Your previous reply called no tool. Reply again and call exactly one tool: ' +
      'build_svg with the complete <svg> document (or ask_question if the request is materially ambiguous).'
  )
}

async function runTurn(
  assistantId: string,
  ctx: PromptContext,
  attempt = 0,
  /** In-conversation transcript of this turn's earlier attempts (tool calls + results). */
  extraMessages: ChatMessage[] = [],
  scope: TurnScope
): Promise<void> {
  const settings = useSettingsStore.getState()

  const messages: ChatMessage[] = [...buildRequestMessages(ctx).messages, ...extraMessages]

  // Multimodal turns need a vision-capable model; fall back like visual review.
  const hasImageParts = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image')
  )

  const handle = streamChat(
    {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: hasImageParts ? settings.visionModel || settings.model : settings.model,
      messages,
      tools: toolsForStage(ctx.stage, ctx.currentSvg !== null),
      toolChoice: 'auto',
    },
    (full) => useChatStore.getState().appendAssistantDelta(assistantId, full),
    (full) => useChatStore.getState().appendAssistantReasoning(assistantId, full),
    (toolName) => useChatStore.getState().setAssistantTool(assistantId, toolName)
  )
  useChatStore.getState().setCancel(handle.cancel)

  /** The turn lost ownership (project changed / new turn) or was cancelled. */
  const interrupted = () =>
    !turnScopeValid(scope) || useChatStore.getState().status === 'canceled'

  let reply: StreamResult
  try {
    reply = await handle.promise
  } catch (e) {
    // A reasoning-only stream is a model fault the retry loop can correct —
    // the nudge tells it to think briefly and answer. Transport/auth/model
    // errors need user action, so they fail the turn for manual retry.
    useChatStore.getState().setAssistantTool(assistantId, null)
    if (interrupted()) {
      // A user cancel aborts the stream as an AbortError; keep the partial
      // reply and stay quiet — a cancel must not surface as an error (audit
      // N6). A stale scope means the stores were hydrated away — write nothing.
      if (turnScopeValid(scope)) useChatStore.getState().interruptAssistant(assistantId)
      return
    }
    if (isEmptyResponseError(e) && attempt < MAX_RETRIES) {
      return runTurn(
        assistantId,
        ctx,
        attempt + 1,
        [...extraMessages, ...emptyResponseAttemptMessages()],
        scope
      )
    }
    useChatStore.getState().failAssistant(assistantId, (e as Error).message)
    useChatStore.getState().markRetryable(assistantId, true)
    return
  }
  // The stream is over — clear the tool-activity cue before dispatching.
  useChatStore.getState().setAssistantTool(assistantId, null)
  useChatStore.getState().setCancel(null)
  if (interrupted()) {
    // Cancel can land between stream end and dispatch — never apply a reply
    // to stores the turn no longer owns.
    if (turnScopeValid(scope)) useChatStore.getState().interruptAssistant(assistantId)
    return
  }

  // Guard: an exception inside response handling must never be swallowed
  // silently (it would leave the turn unfinished and the canvas empty).
  try {
    if (!reply.text.trim() && reply.toolCalls.length === 0) {
      // The stream ended with nothing visible — normally the proxy converts
      // this to an empty-response error; reaching here means it ended
      // abnormally. Same corrective retry, then manual retry once exhausted.
      if (attempt < MAX_RETRIES) {
        return runTurn(
          assistantId,
          ctx,
          attempt + 1,
          [...extraMessages, ...emptyResponseAttemptMessages()],
          scope
        )
      }
      useChatStore
        .getState()
        .failAssistant(assistantId, 'The model returned an empty response')
      useChatStore.getState().markRetryable(assistantId, true)
      return
    }
    await applyReply(assistantId, reply, ctx, attempt, extraMessages, scope)
  } catch (e) {
    console.warn('[snaplot] response handling failed:', e, '\nreply:', reply)
    if (!turnScopeValid(scope)) return
    useChatStore
      .getState()
      .failAssistant(assistantId, `Failed to process response: ${(e as Error).message}`)
  }
}

/** The most recent user instruction, used as the vision review's intent. */
function latestInstruction(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    // Multimodal user message: the text parts carry the instruction.
    return m.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

/**
 * Automatic visual review (VERIFY supplement): rasterize the applied artwork
 * and let a vision model check it against the user's intent. Runs per the
 * visualReviewMode setting ('first' = only when this turn created the first
 * artwork). Never throws — request failures degrade to a visible note.
 */
async function maybeVisualReview(
  ctx: PromptContext,
  firstBuild: boolean
): Promise<{ failed: boolean; note: string | null; issues: string[] | null }> {
  const { visualReviewMode } = useSettingsStore.getState()
  if (visualReviewMode === 'never') return { failed: false, note: null, issues: null }
  if (visualReviewMode === 'first' && !firstBuild) return { failed: false, note: null, issues: null }
  const svg = useEditorStore.getState().currentSvg
  if (!svg) return { failed: false, note: null, issues: null }
  const result = await runVisualReview(svg, latestInstruction(ctx.history), {
    // Register the review stream so the Stop control aborts it too, and so a
    // cancel during review actually stops the request (audit A12/N6).
    registerCancel: (cancel) => useChatStore.getState().setCancel(cancel),
  })
  if (!result.ok) {
    // An aborted review reads as a failure here; the caller's canceled check
    // drops it before any note is rendered.
    return { failed: false, note: `Visual review unavailable: ${result.error}`, issues: null }
  }
  if (result.pass || (result.issues ?? []).length === 0) return { failed: false, note: null, issues: null }
  return { failed: true, note: null, issues: result.issues ?? [] }
}

/**
 * Append review notes to the displayed reply. When the retry budget is spent,
 * unfixed visual-review issues are surfaced to the user instead of being
 * silently dropped.
 */
function withReviewNotes(
  full: string,
  review: { failed: boolean; note: string | null; issues: string[] | null }
): string {
  const suffixes: string[] = []
  if (review.note) suffixes.push(review.note)
  if (review.failed) {
    suffixes.push(`Visual review found issues (retry budget exhausted): ${(review.issues ?? []).join('; ')}`)
  }
  return suffixes.length ? `${full}\n\n${suffixes.map((s) => `*${s}*`).join('\n\n')}` : full
}

/**
 * Apply the LLM-provided project title once the first build succeeds. Only a
 * still-default name is replaced — a user-given name always wins, and later
 * rebuilds cannot clobber it. rename() writes the project record directly
 * (not the content autosave suppressed mid-stream), so this is safe to fire
 * during the turn.
 */
function applyProjectName(name: string | undefined, scope: TurnScope): void {
  if (!name || !turnScopeValid(scope) || scope.projectId === null) return
  const { projects, rename } = useProjectsStore.getState()
  const active = projects.find((p) => p.id === scope.projectId)
  if (!active || active.name !== DEFAULT_PROJECT_NAME) return
  void rename(scope.projectId, name)
}

/** IMPLEMENT + VERIFY: dispatch the tool call, verify results, retry on failure. */
async function applyReply(
  assistantId: string,
  reply: StreamResult,
  ctx: PromptContext,
  attempt: number,
  extraMessages: ChatMessage[],
  scope: TurnScope
): Promise<void> {
  const chat = useChatStore.getState()
  const editor = useEditorStore.getState()
  const canRetry = attempt < MAX_RETRIES
  const retryWith = (messages: ChatMessage[], refresh?: PromptContext) => {
    if (!turnScopeValid(scope)) return
    return runTurn(assistantId, refresh ?? ctx, attempt + 1, [...extraMessages, ...messages], scope)
  }
  /** True when the turn must stop without applying anything further. */
  const abandoned = (): boolean => {
    if (turnScopeValid(scope) && useChatStore.getState().status !== 'canceled') return false
    if (turnScopeValid(scope)) useChatStore.getState().interruptAssistant(assistantId)
    return true
  }

  // No tool call — lenient handling: with artwork the reply is informational;
  // without artwork an action is required, so nudge the model to call a tool.
  const call = reply.toolCalls[0]
  if (!call) {
    if (ctx.currentSvg) {
      // Idempotent no-op during real streams (deltas already carry the text).
      if (abandoned()) return
      chat.appendAssistantDelta(assistantId, reply.text)
      chat.finishAssistant(assistantId)
      return
    }
    if (canRetry) {
      return void retryWith(textOnlyAttemptMessages(reply.text, toolNudge(ctx)))
    }
      editor.setEditError('The model replied without calling a tool; try rephrasing the instruction')
      chat.finishAssistant(assistantId, 'rejected')
      chat.markRetryable(assistantId, true)
      return
  }

  const dispatch = actionFromToolCall(call)
  if (dispatch.kind === 'invalid') {
    if (canRetry) {
      return void retryWith(toolAttemptMessages(reply.text, call, { ok: false, errors: [dispatch.reason] }))
    }
      editor.setEditError(`The tool call could not be used: ${dispatch.reason}`)
      chat.finishAssistant(assistantId, 'rejected')
      chat.markRetryable(assistantId, true)
      return
  }

  const action = dispatch.action

  // QUESTION: clarification — never touches the artwork.
  if (action.action === 'question') {
    if (abandoned()) return
    chat.setAssistantPayload(assistantId, { chips: action.choices })
    chat.finishAssistant(assistantId, 'question')
    return
  }

  // PLAN: propose steps, then wait at the AWAIT_CONFIRM gate. The user either
  // confirms via the chip (ChatPanel sets planConfirmed), edits the checklist,
  // or replies with text — which becomes a plan-revision turn.
  if (action.action === 'plan') {
    if (abandoned()) return
    useChatStore.getState().setTurnStage('await-confirm')
    chat.setAssistantPayload(assistantId, {
      chips: [
        { id: 'confirm-draw', label: 'Looks good, draw it' },
        { id: 'request-changes', label: 'Request changes' },
      ],
      planSteps: action.steps,
      ...(dispatch.attributeControls ? { attributeControls: dispatch.attributeControls } : {}),
    })
    // A new plan supersedes any checklist edits made against the old one.
    useChatStore.getState().resetPlanStepEdits()
    chat.finishAssistant(assistantId, 'plan')
    return
  }

  // BUILD: verify the full document through the safety pipeline.
  if (action.action === 'build') {
    const build = verifySvgBuild(action.svg)
    if (build.ok && build.svg) {
      if (abandoned()) return
      editor.setSvg(build.svg)
      useEditorStore.getState().syncSelectionAfterEdit(build.svg)
      // Artwork exists: the plan (if any) is realized — REPORT stage done.
      useChatStore.getState().setPlanConfirmed(true)
      useChatStore.getState().setTurnStage('idle')
      applyProjectName(action.projectName, scope)
      // First artwork of the turn's canvas: "first" review mode triggers here.
      const review = await maybeVisualReview(ctx, ctx.currentSvg === null)
      // A cancel or project switch during the review ends the turn quietly —
      // no review notes, no repair retries after the user stopped.
      if (abandoned()) return
      if (review.failed && canRetry) {
        // Retry against the artwork the review criticized, not the pre-turn
        // snapshot — the model must see the image it is asked to fix.
        return void retryWith(
          toolAttemptMessages(reply.text, call, {
            ok: true,
            applied: true,
            visualReviewIssues: review.issues ?? [],
          }),
          { ...ctx, currentSvg: canonicalizeSvg(build.svg) }
        )
      }
      chat.appendAssistantDelta(assistantId, withReviewNotes(reply.text, review))
      // No effective change vs current artwork — skip the "Artwork updated" label.
      chat.finishAssistant(assistantId, editor.currentSvg === build.svg ? undefined : 'artwork-updated')
    } else if (canRetry) {
      return void retryWith(toolAttemptMessages(reply.text, call, { ok: false, errors: build.errors }))
    } else {
      console.warn('[snaplot] SVG verification failed:', build.errors, '\nraw svg:', action.svg)
      editor.setEditError(`Failed to apply SVG: ${build.errors.join('; ')}`)
      chat.finishAssistant(assistantId, 'rejected')
      chat.markRetryable(assistantId, true)
    }
    return
  }

  // EDIT: verify + apply targeted operations against the current artwork.
  if (action.action === 'edit') {
    const edit = verifyEdits(editor.currentSvg, action.operations)
    if (edit.ok && edit.svg) {
      if (abandoned()) return
      editor.setSvg(edit.svg)
      useEditorStore.getState().syncSelectionAfterEdit(edit.svg)
      useChatStore.getState().setTurnStage('idle')
      const review = await maybeVisualReview(ctx, false)
      if (abandoned()) return
      if (review.failed && canRetry) {
        // Retry against the post-edit artwork the review criticized.
        return void retryWith(
          toolAttemptMessages(reply.text, call, {
            ok: true,
            applied: true,
            visualReviewIssues: review.issues ?? [],
          }),
          { ...ctx, currentSvg: canonicalizeSvg(edit.svg) }
        )
      }
      chat.appendAssistantDelta(assistantId, withReviewNotes(reply.text, review))
      // No effective change vs current artwork — skip the "Artwork updated" label.
      chat.finishAssistant(assistantId, editor.currentSvg === edit.svg ? undefined : 'artwork-updated')
    } else if (canRetry) {
      return void retryWith(toolAttemptMessages(reply.text, call, { ok: false, errors: edit.errors }))
    } else {
      editor.setEditError(edit.errors.join('; ') || 'Edit operations rejected')
      chat.finishAssistant(assistantId, 'rejected')
      chat.markRetryable(assistantId, true)
    }
    return
  }

  // REPORT-equivalent: informational text only — the reply text is already displayed.
  if (abandoned()) return
  chat.finishAssistant(assistantId)
}
