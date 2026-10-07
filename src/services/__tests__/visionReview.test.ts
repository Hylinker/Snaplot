import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildVisualReviewMessages,
  parseReviewVerdict,
  renderReviewImage,
  runVisualReview,
  sendVisualReviewTurn,
} from '../visionReview'
import { useSettingsStore } from '../../stores/settings'
import { useChatStore } from '../../stores/chat'
import { useEditorStore } from '../../stores/editor'
import type { Rasterizer } from '../export'

vi.mock('../streamClient', () => ({
  streamChat: vi.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { streamChat } from '../streamClient'
const mockStream = vi.mocked(streamChat)

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f00"/></svg>'

const okRasterize: Rasterizer = async () => new Blob(['png'], { type: 'image/png' })
const failingRasterize: Rasterizer = async () => {
  throw new Error('no canvas')
}

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'test-key',
    model: 'text-model',
    visionModel: '',
  })
  useChatStore.getState().clear()
  useEditorStore.setState({ currentSvg: null })
})

describe('buildVisualReviewMessages', () => {
  it('builds a text system prompt and a multimodal user message', () => {
    const messages = buildVisualReviewMessages('a red poster', 'data:image/png;base64,AAA')
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(typeof messages[0].content).toBe('string')
    expect(messages[1].role).toBe('user')
    expect(Array.isArray(messages[1].content)).toBe(true)
    const parts = messages[1].content as { type: string; image?: string; text?: string }[]
    expect(parts[0].type).toBe('text')
    expect(parts[0].text).toContain('a red poster')
    expect(parts[1]).toEqual({ type: 'image', image: 'data:image/png;base64,AAA' })
  })

  it('uses the design-quality prompt in manual mode', () => {
    const messages = buildVisualReviewMessages('a red poster', 'data:image/png;base64,AAA', 'manual')
    expect(messages[0].content).toContain('Technical quality')
    expect(messages[0].content).toContain('Design quality')
    expect(messages[0].content).toContain("same language as the user's intent")
  })

  it('keeps the mechanical-defect prompt by default', () => {
    const messages = buildVisualReviewMessages('a red poster', 'data:image/png;base64,AAA')
    expect(messages[0].content).not.toContain('Technical quality')
    expect(messages[0].content).not.toContain('Design quality')
    expect(messages[0].content).toContain("same language as the user's intent")
  })
})

describe('parseReviewVerdict', () => {
  it('parses a fenced json verdict and drops non-string issues', () => {
    const v = parseReviewVerdict('sure\n```json\n{"pass": false, "issues": ["clipped text", "", 5]}\n```')
    expect(v).toEqual({ pass: false, issues: ['clipped text'], suggestions: [] })
  })

  it('parses an unfenced json reply', () => {
    expect(parseReviewVerdict('{"pass": true, "issues": []}')).toEqual({
      pass: true,
      issues: [],
      suggestions: [],
    })
  })

  it('parses suggestions and drops malformed or duplicate entries', () => {
    const reply =
      '```json\n{"pass": false, "issues": ["a"], "suggestions": [' +
      '{"id": "center-title", "label": "Center the title"}, ' +
      '{"id": "center-title", "label": "duplicate id"}, ' +
      '{"id": "", "label": "empty id"}, ' +
      '{"id": "no-label", "label": ""}, ' +
      '{"label": "missing id"}, ' +
      '"not-an-object", ' +
      '{"id": "tighten-spacing", "label": "Tighten the spacing"}]}\n```'
    const v = parseReviewVerdict(reply)
    expect(v?.suggestions).toEqual([
      { id: 'center-title', label: 'Center the title' },
      { id: 'tighten-spacing', label: 'Tighten the spacing' },
    ])
  })

  it('caps suggestions at five', () => {
    const suggestions = Array.from({ length: 8 }, (_, i) => ({ id: `fix-${i}`, label: `Fix ${i}` }))
    const v = parseReviewVerdict(`{"pass": false, "issues": ["a"], "suggestions": ${JSON.stringify(suggestions)}}`)
    expect(v?.suggestions).toHaveLength(5)
    expect(v?.suggestions?.[4]).toEqual({ id: 'fix-4', label: 'Fix 4' })
  })

  it('returns null for replies without a verdict or a non-boolean pass', () => {
    expect(parseReviewVerdict('looks fine to me')).toBeNull()
    expect(parseReviewVerdict('```json\n{"pass": "yes"}\n```')).toBeNull()
    expect(parseReviewVerdict('broken {')).toBeNull()
  })
})

describe('renderReviewImage', () => {
  it('returns a png data URL', async () => {
    const url = await renderReviewImage(SAMPLE_SVG, { rasterize: okRasterize })
    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('returns null when rasterization fails', async () => {
    expect(await renderReviewImage(SAMPLE_SVG, { rasterize: failingRasterize })).toBeNull()
  })
})

describe('runVisualReview', () => {
  it('uses the vision model when configured and returns the verdict', async () => {
    useSettingsStore.setState({ visionModel: 'vision-model' })
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({ text: '```json\n{"pass": true, "issues": []}\n```', toolCalls: [] }),
    })
    const result = await runVisualReview(SAMPLE_SVG, 'a red poster', { rasterize: okRasterize })
    expect(result).toEqual({ ok: true, pass: true, issues: [], suggestions: [] })
    const request = mockStream.mock.calls[0][0]
    expect(request.model).toBe('vision-model')
    expect(request.messages[1].content).toEqual(
      expect.arrayContaining([{ type: 'image', image: expect.stringMatching(/^data:image\/png/) }])
    )
  })

  it('falls back to the default model', async () => {
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({ text: '{"pass": true, "issues": []}', toolCalls: [] }),
    })
    await runVisualReview(SAMPLE_SVG, '', { rasterize: okRasterize })
    expect(mockStream.mock.calls[0][0].model).toBe('text-model')
  })

  it('reports a render failure without throwing', async () => {
    const result = await runVisualReview(SAMPLE_SVG, '', { rasterize: failingRasterize })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('rendered')
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('reports a stream failure without throwing', async () => {
    const rejection = Promise.reject(new Error('HTTP 401'))
    rejection.catch(() => {}) // keep the eager rejection from firing unhandled
    mockStream.mockReturnValue({ cancel: () => {}, promise: rejection })
    const result = await runVisualReview(SAMPLE_SVG, '', { rasterize: okRasterize })
    expect(result).toEqual({ ok: false, error: 'HTTP 401' })
  })

  it('reports an unparsable reply without throwing', async () => {
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({ text: 'no verdict here', toolCalls: [] }),
    })
    const result = await runVisualReview(SAMPLE_SVG, '', { rasterize: okRasterize })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('verdict')
  })

  it('uses the manual prompt and returns suggestions in manual mode', async () => {
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({
        text:
          '```json\n{"pass": false, "issues": ["title off-center"], ' +
          '"suggestions": [{"id": "center-title", "label": "Center the title"}]}\n```',
        toolCalls: [],
      }),
    })
    const result = await runVisualReview(SAMPLE_SVG, '', {
      rasterize: okRasterize,
      mode: 'manual',
    })
    expect(result).toEqual({
      ok: true,
      pass: false,
      issues: ['title off-center'],
      suggestions: [{ id: 'center-title', label: 'Center the title' }],
    })
    const request = mockStream.mock.calls[0][0]
    expect(request.messages[0].content).toContain('Technical quality')
  })
})

describe('sendVisualReviewTurn', () => {
  it('attaches fix-suggestion chips when issues are found', async () => {
    useEditorStore.setState({ currentSvg: SAMPLE_SVG })
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({
        text:
          '```json\n{"pass": false, "issues": ["title off-center"], ' +
          '"suggestions": [{"id": "center-title", "label": "Center the title"}]}\n```',
        toolCalls: [],
      }),
    })
    await sendVisualReviewTurn({ rasterize: okRasterize })
    const messages = useChatStore.getState().messages
    const last = messages[messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.streaming).toBe(false)
    expect(last.text).toContain('found issues')
    expect(last.chips).toEqual([{ id: 'center-title', label: 'Center the title' }])
  })

  it('attaches suggestion chips even when the review passes', async () => {
    useEditorStore.setState({ currentSvg: SAMPLE_SVG })
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({
        text:
          '```json\n{"pass": true, "issues": [], ' +
          '"suggestions": [{"id": "raise-contrast", "label": "Raise the subtitle contrast"}]}\n```',
        toolCalls: [],
      }),
    })
    await sendVisualReviewTurn({ rasterize: okRasterize })
    const messages = useChatStore.getState().messages
    const last = messages[messages.length - 1]
    expect(last.text).toContain('passed')
    expect(last.chips).toEqual([{ id: 'raise-contrast', label: 'Raise the subtitle contrast' }])
  })

  it('renders a pass report without chips', async () => {
    useEditorStore.setState({ currentSvg: SAMPLE_SVG })
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({ text: '```json\n{"pass": true, "issues": []}\n```', toolCalls: [] }),
    })
    await sendVisualReviewTurn({ rasterize: okRasterize })
    const messages = useChatStore.getState().messages
    const last = messages[messages.length - 1]
    expect(last.text).toContain('passed')
    expect(last.chips).toBeFalsy()
  })

  it('renders a failure report without chips', async () => {
    useEditorStore.setState({ currentSvg: SAMPLE_SVG })
    mockStream.mockReturnValue({
      cancel: () => {},
      promise: Promise.resolve({ text: 'no verdict here', toolCalls: [] }),
    })
    await sendVisualReviewTurn({ rasterize: okRasterize })
    const messages = useChatStore.getState().messages
    const last = messages[messages.length - 1]
    expect(last.text).toContain('failed')
    expect(last.chips).toBeFalsy()
  })
})

