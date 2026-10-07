import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, tool, jsonSchema, APICallError, type ModelMessage, type ToolSet } from 'ai'
import type { ChatMessage, ToolDeclaration } from '../types'

/**
 * Dev-only proxy: POST /api/chat -> OpenAI-compatible provider via the
 * Vercel AI SDK. Transport only — no application logic lives here.
 */

// Base64 screenshots for vision review can reach a few MB; 10 MB is a hard
// safety cap that still leaves room for large SVG payloads.
const MAX_REQUEST_BYTES = 10 * 1024 * 1024
// Long thinking streams can run for many minutes; cancellation is the
// client's job (Cancel button). This is only a hard safety cap.
const REQUEST_TIMEOUT_MS = 600_000

/** Approved HTTPS host patterns for the development proxy (docs/build-plan.md, Open Question 3). */
const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /^api\.openai\.com$/i,
  /^api\.anthropic\.com$/i,
  /^api\.deepseek\.com$/i,
  /^api\.moonshot\.cn$/i,
  /^open\.bigmodel\.cn$/i,
  /^api\.siliconflow\.cn$/i,
  /^dashscope\.aliyuncs\.com$/i,
  /^(localhost|127\.0\.0\.1)(:\d+)?$/i,
]

interface ProxyChatRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  /** Client-executed tool declarations; the stream emits tool-call parts. */
  tools?: ToolDeclaration[]
  toolChoice?: 'auto' | 'required'
}

/** Map wire-format tool declarations to SDK tools without execute functions. */
function toSdkTools(declarations: ToolDeclaration[]): ToolSet {
  const tools: ToolSet = {}
  for (const d of declarations) {
    tools[d.name] = tool({
      description: d.description,
      inputSchema: jsonSchema(d.parameters),
    })
  }
  return tools
}

type ErrorCategory = 'connection' | 'auth' | 'model' | 'streaming' | 'canceled'

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeChunk(res: ServerResponse, chunk: unknown) {
  if (!res.writableEnded) res.write(JSON.stringify(chunk) + '\n')
}

function allowedUrl(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const localhost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url.hostname)
  const hostOk = url.protocol === 'https:' ? ALLOWED_HOST_PATTERNS.some((p) => p.test(url.hostname)) : localhost
  if (!hostOk) return null
  return url
}

function categorizeApiError(err: APICallError): ErrorCategory {
  if (err.statusCode === 401 || err.statusCode === 403) return 'auth'
  if (err.statusCode === 404 || err.statusCode === 400 || err.statusCode === 422) return 'model'
  return 'connection'
}

/** Strip Authorization and any key-like substring from error text. */
function redact(text: string, apiKey: string): string {
  return text.replace(new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'sk-***')
}

export function chatProxy(): Plugin {
  return {
    name: 'snaplot-chat-proxy',
    configureServer(server) {
      server.middlewares.use(
        '/api/chat',
        (async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            writeJson(res, 405, { error: 'method not allowed' })
            return
          }

          const body = await new Promise<string | null>((resolve) => {
            let data = ''
            let aborted = false
            req.on('data', (c: Buffer) => {
              data += c
              if (data.length > MAX_REQUEST_BYTES) {
                aborted = true
                writeJson(res, 413, { error: 'payload too large' })
                req.destroy()
              }
            })
            req.on('end', () => resolve(aborted ? null : data))
            req.on('error', () => resolve(null))
          })
          if (body === null) return

          let parsed: ProxyChatRequest
          try {
            parsed = JSON.parse(body) as ProxyChatRequest
          } catch {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }

          const url = allowedUrl(parsed.baseUrl ?? '')
          if (!url || !parsed.model || !Array.isArray(parsed.messages) || !parsed.apiKey) {
            writeJson(res, 400, { error: 'baseUrl not allowed or missing apiKey/model/messages' })
            return
          }

          const provider = createOpenAICompatible({
            name: 'snaplot-provider',
            baseURL: url.href,
            apiKey: parsed.apiKey,
          })

          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' })

          try {
            // The AI SDK rejects system entries inside `messages`; move them
            // to the `system` option (joined).
            const systemContents: string[] = []
            const chatMessages: ModelMessage[] = []
            for (const m of parsed.messages as ModelMessage[]) {
              // Array content (text + image parts) passes through untouched;
              // only plain-string system content can move to the system option.
              if (m.role === 'system' && typeof m.content === 'string') systemContents.push(m.content)
              else chatMessages.push(m)
            }

            let streamError: unknown = null
            const result = streamText({
              model: provider.chatModel(parsed.model),
              ...(systemContents.length > 0 ? { system: systemContents.join('\n\n') } : {}),
              messages: chatMessages,
              ...(parsed.tools && parsed.tools.length > 0
                ? { tools: toSdkTools(parsed.tools), toolChoice: parsed.toolChoice ?? 'auto' }
                : {}),
              abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              // Reasoning models can spend tens of thousands of tokens
              // thinking before any content arrives — give them room to
              // finish both channels.
              maxOutputTokens: 65536,
              // Connection/protocol failures surface here, not via the
              // stream iterator.
              onError: ({ error }) => {
                streamError ??= error
              },
            })

            // Thinking is left enabled. Reasoning (reasoning_content) is
            // forwarded as a separate chunk field so the client can show it
            // in a collapsed panel; content deltas remain the only source of
            // displayed text. Both channels are logged to the dev console.
            let textCount = 0
            let toolCallCount = 0
            let contentText = ''
            let reasoningText = ''
            let finishReason: string | null = null
            const startedAt = Date.now()
            for await (const part of result.fullStream) {
              if (res.writableEnded || res.destroyed) return
              if (part.type === 'text-delta') {
                writeChunk(res, { delta: part.text })
                textCount++
                contentText += part.text
              } else if (part.type === 'reasoning-delta') {
                writeChunk(res, { reasoning: part.text })
                reasoningText += part.text
              } else if (part.type === 'tool-input-start') {
                // Tool arguments started streaming — surfaced as a progress cue.
                writeChunk(res, { toolStart: part.toolName })
              } else if (part.type === 'tool-call') {
                writeChunk(res, {
                  toolCall: {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    input: part.input,
                  },
                })
                toolCallCount++
              } else if (part.type === 'finish') {
                finishReason = part.finishReason
              } else if (part.type === 'error') {
                streamError ??= part.error
              }
            }
            if (streamError !== null) throw streamError
            console.log(
              `[snaplot-chat] content (${contentText.length} chars, finish=${finishReason}, ${Math.round((Date.now() - startedAt) / 1000)}s):`,
              JSON.stringify(contentText)
            )
            console.log(
              `[snaplot-chat] reasoning (${reasoningText.length} chars, truncated):`,
              JSON.stringify(reasoningText.slice(0, 2000))
            )
            // A tool-only turn has no content text but is a complete reply.
            if (textCount === 0 && toolCallCount === 0) {
              const truncated =
                finishReason === 'length'
                  ? ` The reasoning channel used up the entire max_tokens budget (${reasoningText.length} chars of thinking) before any content was generated.`
                  : ''
              writeChunk(res, {
                error: {
                  category: 'streaming',
                  // Machine-readable marker: streamClient turns this into an
                  // empty-response error the runner can auto-retry.
                  code: 'empty-response',
                  message:
                    'the model returned an empty response (all output went to the reasoning ' +
                    'channel).' +
                    truncated +
                    ' Try again or use a model with shorter thinking.',
                },
              })
              res.end()
              return
            }
            writeChunk(res, { done: true })
            res.end()
          } catch (e) {
            const err = e as APICallError & { name?: string; message: string; url?: string }
            const canceled = err.name === 'AbortError' || res.destroyed
            const isConnect = /cannot connect|fetch failed|ECONNREFUSED/i.test(err.message)
            const category: ErrorCategory = canceled
              ? 'canceled'
              : APICallError.isInstance(err)
                ? categorizeApiError(err)
                : isConnect
                  ? 'connection'
                  : 'streaming'
            const detail = redact(err.responseBody ?? err.message, parsed.apiKey)
            const status = APICallError.isInstance(err) && err.statusCode ? `HTTP ${err.statusCode} ` : ''
            const hint =
              APICallError.isInstance(err) && err.statusCode === 404
                ? ' | Hint: the Base URL must be the provider\'s full API path, e.g. https://api.openai.com/v1, https://open.bigmodel.cn/api/paas/v4, https://dashscope.aliyuncs.com/compatible-mode/v1, http://localhost:11434/v1 (Ollama).'
                : ''
            const urlInfo = err.url ? `at ${err.url}` : ''
            writeChunk(res, {
              error: { category, message: `${status}${urlInfo} ${detail}${hint}`.trim().slice(0, 800) },
            })
            res.end()
          }
        }) as never
      )
    },
  }
}
