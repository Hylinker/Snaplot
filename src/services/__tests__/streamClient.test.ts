import { afterEach, describe, expect, it, vi } from 'vitest'
import { isEmptyResponseError, streamChat } from '../streamClient'

const ndjson = (...chunks: unknown[]) => new Response(chunks.map((c) => JSON.stringify(c) + '\n').join(''))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamChat', () => {
  it('accumulates text deltas into a StreamResult', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ndjson({ delta: 'Hello ' }, { delta: 'there' }, { done: true }))
    )
    const deltas: string[] = []
    const result = await streamChat({ baseUrl: 'u', apiKey: 'k', model: 'm', messages: [] }, (full) =>
      deltas.push(full)
    ).promise
    expect(result).toEqual({ text: 'Hello there', toolCalls: [] })
    expect(deltas).toEqual(['Hello ', 'Hello there'])
  })

  it('collects completed tool calls and reports tool starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjson(
          { delta: 'Drawing now.' },
          { toolStart: 'build_svg' },
          { toolCall: { toolCallId: 'call-1', toolName: 'build_svg', input: { svg: '<svg/>' } } },
          { done: true }
        )
      )
    )
    const starts: string[] = []
    const result = await streamChat(
      { baseUrl: 'u', apiKey: 'k', model: 'm', messages: [] },
      () => {},
      undefined,
      (toolName) => starts.push(toolName)
    ).promise
    expect(starts).toEqual(['build_svg'])
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call-1', toolName: 'build_svg', input: { svg: '<svg/>' } },
    ])
    expect(result.text).toBe('Drawing now.')
  })

  it('sends tools and toolChoice in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ndjson({ delta: 'ok' }, { done: true }))
    vi.stubGlobal('fetch', fetchMock)
    await streamChat(
      {
        baseUrl: 'u',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'build_svg', description: 'd', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      },
      () => {}
    ).promise
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.tools).toEqual([{ name: 'build_svg', description: 'd', parameters: { type: 'object' } }])
    expect(body.toolChoice).toBe('auto')
  })

  it('throws on error chunks and non-OK responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ndjson({ error: { category: 'model', message: 'bad tools' } }))
    )
    await expect(
      streamChat({ baseUrl: 'u', apiKey: 'k', model: 'm', messages: [] }, () => {}).promise
    ).rejects.toThrow('model: bad tools')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(
      streamChat({ baseUrl: 'u', apiKey: 'k', model: 'm', messages: [] }, () => {}).promise
    ).rejects.toThrow('request failed: 500')
  })

  it('marks reasoning-only streams as empty-response errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjson(
          { reasoning: 'thinking…' },
          {
            error: {
              category: 'streaming',
              code: 'empty-response',
              message: 'the model returned an empty response',
            },
          }
        )
      )
    )
    const error = await streamChat({ baseUrl: 'u', apiKey: 'k', model: 'm', messages: [] }, () => {})
      .promise.then(
        () => null,
        (e) => e
      )
    expect(isEmptyResponseError(error)).toBe(true)
    expect(error.message).toBe('streaming: the model returned an empty response')
    expect(isEmptyResponseError(new Error('streaming: the model returned an empty response'))).toBe(
      false
    )
  })
})
