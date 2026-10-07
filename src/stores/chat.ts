import { create } from 'zustand'
import type { AttributeValues } from '../svg/attributes'
import type { ChatStatus, PlanStep, PlanStepEdit, ProjectContent, UiMessage } from '../types'
import { stripFencedBlocks } from '../svg/extract'
import { normalizePlanSteps } from '../services/planSteps'

let nextId = 1
const genId = () => `msg-${nextId++}-${Date.now().toString(36)}`

/** A plan step overlaid with the user's checklist edit state. */
export interface AnnotatedPlanStep extends PlanStep {
  included: boolean
}

/**
 * Overlay checklist edits on a plan's steps: labels are renamed, steps default
 * to included. Steps without an edit pass through unchanged. Inputs are
 * normalized first (non-empty unique ids), so plans persisted before dispatch
 * normalization — with empty or duplicated ids — still key edits correctly.
 */
export function annotatePlanSteps(
  steps: PlanStep[],
  edits: Record<string, PlanStepEdit>
): AnnotatedPlanStep[] {
  return normalizePlanSteps(steps).map((s) => {
    const edit = edits[s.id]
    return edit ? { id: s.id, label: edit.label, included: edit.included } : { ...s, included: true }
  })
}

/**
 * The most recent plan reply in a thread (structured steps or a legacy
 * confirm-draw chip), searching backwards. Derived from persisted messages so
 * it survives reloads and project switches — the ephemeral turnStage cannot.
 */
export function findLatestPlan(messages: UiMessage[]): UiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if ((m.planSteps?.length ?? 0) > 0) return m
    if (m.chips?.some((c) => c.id === 'confirm-draw')) return m
  }
  return null
}

/**
 * Index of the user message that triggered the assistant message at `index`,
 * or -1 when that reply has no user message of its own. Normal turns always
 * append their user message first, so encountering an assistant message while
 * scanning backwards means the target is a standalone reply (a manual visual
 * review) — its "turn user" belongs to an earlier turn and must not be
 * attributed to it.
 */
export function findTurnUserIndex(messages: UiMessage[], index: number): number {
  for (let k = index - 1; k >= 0; k--) {
    if (messages[k].role === 'user') return k
    if (messages[k].role === 'assistant') return -1
  }
  return -1
}

interface ChatState {
  messages: UiMessage[]
  status: ChatStatus
  lastError: string | null
  /** Ids of failed assistant messages that can be retried. */
  retryableIds: string[]
  cancel: (() => void) | null
  /** Values chosen in the attribute-controls panel. */
  attributeValues: AttributeValues
  /** True once the user confirmed the pre-draw plan (first artwork may be generated). */
  planConfirmed: boolean
  /** Checklist adjustments (exclude/rename) for the pending plan's steps. */
  planStepEdits: Record<string, PlanStepEdit>
  /** Current agent-turn stage (observability for the UI). */
  turnStage: 'idle' | 'plan' | 'await-confirm' | 'implement'
  /** Composer text, persisted per project so it follows project switches. */
  draft: string
}

interface ChatActions {
  appendUser: (text: string, selection?: UiMessage['selection'], images?: string[]) => UiMessage
  beginAssistant: () => string
  appendAssistantDelta: (id: string, raw: string) => void
  appendAssistantReasoning: (id: string, reasoning: string) => void
  finishAssistant: (id: string, outcome?: UiMessage['outcome']) => void
  failAssistant: (id: string, error: string) => void
  /**
   * End an in-flight assistant message after a user cancel: keep the partial
   * reply, leave it retryable, and surface no error banner. Messages that no
   * longer exist (the project was switched away) are left untouched.
   */
  interruptAssistant: (id: string) => void
  setStatus: (status: ChatStatus, error?: string | null) => void
  setCancel: (cancel: (() => void) | null) => void
  cancelActive: () => void
  markRetryable: (id: string, retryable: boolean) => void
  /** Record the canvas SVG that existed before this assistant turn started. */
  setSvgBefore: (id: string, svg: string | null) => void
  /** Attach structured payloads (chips, plan steps, attribute controls) to a reply. */
  setAssistantPayload: (
    id: string,
    payload: {
      chips?: UiMessage['chips']
      planSteps?: UiMessage['planSteps']
      attributeControls?: UiMessage['attributeControls']
    }
  ) => void
  /** Mark which tool is currently streaming its arguments (progress cue). */
  setAssistantTool: (id: string, toolName: string | null) => void
  /**
   * Withdraw an assistant reply: remove it, the user message that triggered
   * it, and everything after. Returns the reply's svgBefore snapshot
   * (undefined for legacy messages that predate the feature).
   */
  withdraw: (id: string) => string | null | undefined
  setAttributeValue: (id: string, value: string | number | boolean) => void
  setPlanStepEdit: (stepId: string, edit: PlanStepEdit) => void
  /** Drop all checklist edits — a newly proposed plan becomes the baseline. */
  resetPlanStepEdits: () => void
  /** Record a clicked chip so it renders disabled instead of staying live. */
  markChipUsed: (messageId: string, chipId: string) => void
  setPlanConfirmed: (confirmed: boolean) => void
  setTurnStage: (stage: ChatState['turnStage']) => void
  setDraft: (draft: string) => void
  clear: () => void
  /**
   * Load persisted project content into the store (R5 projects replace the
   * former localStorage draft as the persistence authority).
   */
  hydrate: (content: ProjectContent) => void
}

export const useChatStore = create<ChatState & ChatActions>()(
    (set, get) => ({
      messages: [],
      status: 'idle',
      lastError: null,
      retryableIds: [],
      cancel: null,
      attributeValues: {},
      planConfirmed: false,
      planStepEdits: {},
      turnStage: 'idle',
      draft: '',

      appendUser: (text: string, selection?: UiMessage['selection'], images?: string[]) => {
        const msg: UiMessage = {
          id: genId(),
          role: 'user',
          text,
          selection: selection ?? null,
          ...(images && images.length > 0 ? { images } : {}),
        }
        set((s) => ({ messages: [...s.messages, msg] }))
        return msg
      },

      beginAssistant: () => {
        const id = genId()
        set((s) => ({
          status: 'streaming',
          messages: [...s.messages, { id, role: 'assistant', text: '', raw: '', reasoning: '', streaming: true }],
        }))
        return id
      },

      appendAssistantDelta: (id, raw) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, raw, text: stripFencedBlocks(raw) } : m
          ),
        })),

      appendAssistantReasoning: (id, reasoning) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, reasoning } : m)),
        })),

      finishAssistant: (id, outcome) =>
        set((s) => ({
          status: 'idle',
          messages: s.messages.map((m) => (m.id === id ? { ...m, streaming: false, outcome } : m)),
        })),

      failAssistant: (id, error) =>
        set((s) => ({
          status: 'error',
          lastError: error,
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, streaming: false, error } : m
          ),
        })),

      interruptAssistant: (id) => {
        const exists = get().messages.some((m) => m.id === id)
        set((s) => ({
          status: 'idle',
          lastError: null,
          retryableIds: exists ? [...new Set([...s.retryableIds, id])] : s.retryableIds,
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, streaming: false, toolActive: null } : m
          ),
        }))
      },

      setStatus: (status, error = null) => set({ status, lastError: error }),

      setCancel: (cancel) => set({ cancel }),

      cancelActive: () => {
        // Only meaningful mid-stream: a cancel outside a turn must not flip
        // the status, and the handle must not survive its own invocation.
        if (useChatStore.getState().status !== 'streaming') return
        const { cancel } = useChatStore.getState()
        cancel?.()
        set({ cancel: null, status: 'canceled', lastError: null })
      },

      markRetryable: (id, retryable) =>
        set((s) => ({
          retryableIds: retryable
            ? [...new Set([...s.retryableIds, id])]
            : s.retryableIds.filter((x) => x !== id),
        })),

      setSvgBefore: (id, svg) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, svgBefore: svg } : m)),
        })),

      setAssistantPayload: (id, payload) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, ...payload } : m)),
        })),

      setAssistantTool: (id, toolName) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, toolActive: toolName } : m)),
        })),

      withdraw: (id) => {
        const s = get()
        const i = s.messages.findIndex((m) => m.id === id)
        if (i === -1) return undefined
        const svgBefore = s.messages[i].svgBefore
        // Remove the triggering user message and everything after it. A
        // standalone reply (manual visual review) has no user message of its
        // own — only the reply itself is removed, later turns stay.
        const u = findTurnUserIndex(s.messages, i)
        const removed = new Set(
          (u === -1 ? s.messages.filter((m) => m.id === id) : s.messages.slice(u)).map((m) => m.id)
        )
        set({
          messages:
            u === -1
              ? s.messages.filter((m) => m.id !== id)
              : s.messages.slice(0, u),
          retryableIds: s.retryableIds.filter((x) => !removed.has(x)),
        })
        return svgBefore
      },

      setAttributeValue: (id, value) =>
        set((s) => ({ attributeValues: { ...s.attributeValues, [id]: value } })),

      setPlanStepEdit: (stepId, edit) =>
        set((s) => ({ planStepEdits: { ...s.planStepEdits, [stepId]: edit } })),

      resetPlanStepEdits: () => set({ planStepEdits: {} }),

      markChipUsed: (messageId, chipId) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === messageId
              ? { ...m, chipsUsed: [...new Set([...(m.chipsUsed ?? []), chipId])] }
              : m
          ),
        })),

      setPlanConfirmed: (planConfirmed) => set({ planConfirmed }),

      setTurnStage: (turnStage) => set({ turnStage }),

      setDraft: (draft) => set({ draft }),

      clear: () =>
        set({
          messages: [],
          status: 'idle',
          lastError: null,
          retryableIds: [],
          cancel: null,
          attributeValues: {},
          planConfirmed: false,
          planStepEdits: {},
          turnStage: 'idle',
          draft: '',
        }),

      hydrate: (content) =>
        set({
          messages: content.messages.map((m) => ({
            ...m,
            streaming: false,
          })),
          status: 'idle',
          lastError: null,
          retryableIds: content.retryableIds,
          cancel: null,
          attributeValues: content.attributeValues,
          planConfirmed: content.planConfirmed,
          planStepEdits: content.planStepEdits ?? {},
          turnStage: 'idle',
          draft: content.draft ?? '',
        }),
    }),
  )
