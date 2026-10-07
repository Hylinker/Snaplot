import type { AttributeControl } from './svg/attributes'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** Multimodal content part; `image` is a base64 data URL. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: { type: 'json'; value: unknown } }

export interface ChatMessage {
  role: ChatRole
  /** Plain text, or content parts for multimodal (vision) requests. */
  content: string | ContentPart[]
}

export type MockScenario = 'clear-build' | 'ambiguous' | 'refine'

export interface ChatRequest {
  scenario?: MockScenario
  messages: ChatMessage[]
  /** Canonical current editor SVG, when artwork is loaded. */
  currentSvg?: string | null
  selectedElementId?: string | null
}

/** One completed tool call emitted by the model. */
export interface ToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

/** Tool declaration sent to the provider (OpenAI-compatible function schema). */
export interface ToolDeclaration {
  name: string
  description: string
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>
}

/** SSE-style streamed chunk emitted by POST /api/chat. */
export interface ChatStreamChunk {
  delta?: string
  /** Reasoning-channel delta (reasoning_content), kept separate from content. */
  reasoning?: string
  /** Tool arguments started streaming in; value is the tool name (progress cue). */
  toolStart?: string
  /** A completed tool call emitted by the model. */
  toolCall?: ToolCall
  done?: boolean
  error?: {
    category: 'connection' | 'auth' | 'model' | 'streaming' | 'canceled'
    message: string
    /** Machine-readable marker: the stream produced only reasoning output. */
    code?: 'empty-response'
  }
}

/** One drawing step of a proposed plan (id is the model's stable id). */
export interface PlanStep {
  id: string
  label: string
}

/** User adjustment to one step of the pending plan checklist. */
export interface PlanStepEdit {
  included: boolean
  label: string
}

// ---- Chat UI state ----

export type ChatStatus = 'idle' | 'streaming' | 'error' | 'canceled'

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  /** Visible text only; fenced payloads are stripped before display. */
  text: string
  /** Raw response text including fenced blocks (kept for retry/context). */
  raw?: string
  /** Full reasoning (reasoning_content) text, shown in a collapsed panel. */
  reasoning?: string
  streaming?: boolean
  error?: string
  /** Outcome badge for assistant messages once known. */
  outcome?: 'artwork-updated' | 'rejected' | 'question' | 'plan'
  /** Snapshot of the canvas selection when this user message was sent. */
  selection?: { id: string; tagName: string } | null
  /** Attached reference images, as base64 data URLs. */
  images?: string[]
  /** Canvas SVG before this turn started (withdraw/restore). */
  svgBefore?: string | null
  /** Choice chips for this reply (question/plan tool calls). */
  chips?: { id: string; label: string }[] | null
  /** Chips the user already clicked (rendered disabled). */
  chipsUsed?: string[]
  /** Drawing steps attached to a plan reply (checklist source). */
  planSteps?: PlanStep[] | null
  /** Pre-draw attribute controls attached to a plan reply. */
  attributeControls?: AttributeControl[] | null
  /** Tool currently streaming its arguments (progress cue). */
  toolActive?: string | null
}

export type ChatStatusFields = ChatStatus

// ---- Projects (R5) ----

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

/** Persisted per-project snapshot of the chat + editor store slices. */
export interface ProjectContent {
  messages: UiMessage[]
  retryableIds: string[]
  attributeValues: Record<string, string | number | boolean>
  planConfirmed: boolean
  /** Checklist adjustments (exclude/rename) for the pending plan's steps. */
  planStepEdits?: Record<string, PlanStepEdit>
  /** Composer draft; absent in records persisted before per-project drafts. */
  draft?: string
  revision: number
  manualRevision: number
  currentSvg: string | null
}

export const emptyProjectContent = (): ProjectContent => ({
  messages: [],
  retryableIds: [],
  attributeValues: {},
  planConfirmed: false,
  draft: '',
  revision: 0,
  manualRevision: 0,
  currentSvg: null,
})

// ---- Export (R4) ----

export interface PngExportOptions {
  /** Target base width in pixels before scaling. */
  width: number
  /** Multiplier applied to width (height follows the aspect ratio). */
  scale: number
  /** CSS color painted under the artwork, or null for transparent. */
  background: string | null
  /** Rasterization deadline; defaults to DEFAULT_PNG_TIMEOUT_MS. */
  timeoutMs?: number
}

export type SvgExportResult = { ok: true; svg: string } | { ok: false; error: string }

export type PngExportResult =
  | { ok: true; blob: Blob; width: number; height: number }
  | { ok: false; error: string }
