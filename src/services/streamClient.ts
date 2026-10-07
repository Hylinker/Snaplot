import type { ChatMessage, ChatStreamChunk, ToolCall, ToolDeclaration } from '../types'

export interface StreamResult {
  /** Full accumulated content text. */
  text: string
  /** Completed tool calls emitted by the model (empty on text-only turns). */
  toolCalls: ToolCall[]
}

export interface StreamHandle {
  cancel: () => void
  promise: Promise<StreamResult>
}

/**
 * True when the error marks a reasoning-only stream (the model produced no
 * text and no tool call). The runner auto-retries this condition with a
 * corrective nudge; other stream errors need user action.
 */
export function isEmptyResponseError(e: unknown): boolean {
  return e instanceof Error && (e as Error & { code?: string }).code === 'empty-response'
}

export interface StreamRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  /** Tool declarations; omitting them keeps the request text-only. */
  tools?: ToolDeclaration[]
  /** 'auto' lets the model answer with text or one tool call. */
  toolChoice?: 'auto' | 'required'
}

/**
 * POST /api/chat and consume the NDJSON stream, returning the accumulated
 * text plus any tool calls. Deltas, reasoning and tool-argument starts are
 * surfaced through callbacks as accumulated values.
 */
export function streamChat(
  request: StreamRequest,
  onDelta: (full: string) => void,
  onReasoning?: (full: string) => void,
  onToolStart?: (toolName: string) => void
): StreamHandle {
  const controller = new AbortController()
  const promise = (async () => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      let message = `request failed: ${res.status}`
      try {
        const j = (await res.json()) as { error?: string | { message?: string } }
        if (typeof j.error === 'string') message = j.error
        else if (j.error?.message) message = j.error.message
      } catch {
        // keep default
      }
      throw new Error(message)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let reasoning = ''
    let toolCalls: ToolCall[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const chunk = JSON.parse(line) as ChatStreamChunk
        if (chunk.error) {
          const err = Object.assign(new Error(`${chunk.error.category}: ${chunk.error.message}`), {
            ...(chunk.error.code ? { code: chunk.error.code } : {}),
          })
          throw err
        }
        if (chunk.reasoning) {
          reasoning += chunk.reasoning
          onReasoning?.(reasoning)
        }
        if (chunk.delta) {
          full += chunk.delta
          onDelta(full)
        }
        if (chunk.toolStart) onToolStart?.(chunk.toolStart)
        if (chunk.toolCall) toolCalls = [...toolCalls, chunk.toolCall]
        if (chunk.done) return { text: full, toolCalls }
      }
    }
    return { text: full, toolCalls }
  })()
  return { cancel: () => controller.abort(), promise }
}
