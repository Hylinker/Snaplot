import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendChatMessage, useHistory } from '../agentRunner'
import { streamChat, type StreamResult } from '../streamClient'
import { createProject } from '../projectDb'
import { useChatStore } from '../../stores/chat'
import { useEditorStore } from '../../stores/editor'
import { useSettingsStore } from '../../stores/settings'
import { DEFAULT_PROJECT_NAME, useProjectsStore } from '../../stores/projects'

vi.mock('../streamClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../streamClient')>()),
  streamChat: vi.fn(),
}))

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'
const UNDRAWABLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>'

const replyHandle = (reply: Partial<StreamResult>) => ({
  cancel: () => {},
  promise: Promise.resolve({ text: '', toolCalls: [], ...reply } as StreamResult),
})

/** A stream that failed because the model produced only reasoning output. */
const emptyResponseHandle = () => ({
  cancel: () => {},
  promise: Promise.reject(
    Object.assign(
      new Error(
        'streaming: the model returned an empty response (all output went to the reasoning channel).'
      ),
      { code: 'empty-response' }
    )
  ),
})

const planReply = replyHandle({
  text: 'Here is my plan.',
  toolCalls: [
    { toolCallId: 'c1', toolName: 'propose_plan', input: { steps: [{ id: 's1', label: 'Sky' }] } },
  ],
})

describe('useHistory', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
    useEditorStore.getState().clear()
  })

  it('mirrors the store exactly — no duplicated trailing user message', () => {
    useChatStore.getState().appendUser('draw a cat')
    const id = useChatStore.getState().beginAssistant()
    useChatStore.getState().appendAssistantDelta(id, 'here you go')
    useChatStore.getState().finishAssistant(id)
    useChatStore.getState().appendUser('make it blue')

    const history = useHistory()
    expect(history.map((m) => m.content)).toEqual([
      'draw a cat',
      'here you go', // assistant history uses raw (tool turns carry plain text)
      'make it blue',
    ])
  })

  it('excludes withdrawn replies', () => {
    useChatStore.getState().appendUser('draw a cat')
    const id = useChatStore.getState().beginAssistant()
    useChatStore.getState().appendAssistantDelta(id, 'bad reply')
    useChatStore.getState().finishAssistant(id)
    useChatStore.getState().appendUser('more')

    useChatStore.getState().withdraw(id)
    expect(useHistory().map((m) => m.content)).toEqual([])
  })

  it('sends images as content parts for only the newest image-bearing messages', () => {
    const finish = (text: string) => {
      const id = useChatStore.getState().beginAssistant()
      useChatStore.getState().appendAssistantDelta(id, text)
      useChatStore.getState().finishAssistant(id)
    }
    useChatStore.getState().appendUser('first', undefined, ['data:image/png;base64,AAA'])
    finish('one')
    useChatStore.getState().appendUser('second', undefined, ['data:image/png;base64,BBB'])
    finish('two')
    useChatStore.getState().appendUser('third', undefined, ['data:image/png;base64,CCC'])
    useChatStore.getState().appendUser('no images')

    const history = useHistory()
    expect(history.map((m) => m.content)).toEqual([
      // Budget is 2 image-bearing messages: the oldest degrades to a note.
      'first (reference image omitted)',
      'one',
      [
        { type: 'text', text: 'second' },
        { type: 'image', image: 'data:image/png;base64,BBB' },
      ],
      'two',
      [
        { type: 'text', text: 'third' },
        { type: 'image', image: 'data:image/png;base64,CCC' },
      ],
      'no images',
    ])
  })

  it('falls back to a placeholder text part for image-only messages', () => {
    useChatStore.getState().appendUser('', undefined, ['data:image/png;base64,AAA'])
    expect(useHistory()[0].content).toEqual([
      { type: 'text', text: '(image attached)' },
      { type: 'image', image: 'data:image/png;base64,AAA' },
    ])
  })
})

describe('sendChatMessage', () => {
  beforeEach(async () => {
    useChatStore.getState().clear()
    useEditorStore.getState().clear()
    useSettingsStore.setState({
      baseUrl: 'https://example.com/v1',
      apiKey: 'key',
      model: 'main-model',
      visionModel: '',
      visualReviewMode: 'never',
    })
    useProjectsStore.setState({
      projects: [],
      activeProjectId: null,
      status: 'idle',
      error: null,
    })
    vi.clearAllMocks()
    vi.mocked(streamChat).mockReturnValue(planReply)
  })

  it('sends images as content parts and routes multimodal turns to the vision model', async () => {
    useSettingsStore.setState({ visionModel: 'vision-model' })
    await sendChatMessage('draw this', ['data:image/png;base64,AAA'])

    const user = useChatStore.getState().messages.find((m) => m.role === 'user')
    expect(user?.images).toEqual(['data:image/png;base64,AAA'])

    const request = vi.mocked(streamChat).mock.calls[0][0]
    expect(request.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'draw this' },
      { type: 'image', image: 'data:image/png;base64,AAA' },
    ])
    expect(request.model).toBe('vision-model')
  })

  it('keeps plain text turns on the main model', async () => {
    await sendChatMessage('draw this')
    expect(vi.mocked(streamChat).mock.calls[0][0].model).toBe('main-model')
  })

  it('offers stage tools and requires auto tool choice', async () => {
    await sendChatMessage('draw this')
    const request = vi.mocked(streamChat).mock.calls[0][0]
    expect(request.toolChoice).toBe('auto')
    expect(request.tools?.map((t) => t.name)).toEqual(['propose_plan', 'ask_question'])
  })

  it('applies a build tool call end to end', async () => {
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG } }],
      })
    )
    await sendChatMessage('draw a cat')

    expect(useEditorStore.getState().currentSvg).toContain('<rect')
    const last = useChatStore.getState().messages.at(-1)
    expect(last?.outcome).toBe('artwork-updated')
    expect(last?.text).toContain('Here is the artwork.')
  })

  it('applies the LLM project title to a default-named project on first build', async () => {
    const project = await createProject(DEFAULT_PROJECT_NAME)
    useProjectsStore.setState({ projects: [project], activeProjectId: project.id })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG, name: 'Mountain Sunset' } },
        ],
      })
    )
    await sendChatMessage('draw a mountain sunset')

    // rename() is fire-and-forget inside the turn — poll for the store update.
    await vi.waitFor(() => {
      expect(useProjectsStore.getState().projects.find((p) => p.id === project.id)?.name).toBe(
        'Mountain Sunset'
      )
    })
  })

  it('never overrides a user-given project name', async () => {
    const project = await createProject('My own title')
    useProjectsStore.setState({ projects: [project], activeProjectId: project.id })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG, name: 'Mountain Sunset' } },
        ],
      })
    )
    await sendChatMessage('draw a mountain sunset')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(useProjectsStore.getState().projects.find((p) => p.id === project.id)?.name).toBe(
      'My own title'
    )
  })

  it('keeps the default name when the build carries no title', async () => {
    const project = await createProject(DEFAULT_PROJECT_NAME)
    useProjectsStore.setState({ projects: [project], activeProjectId: project.id })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG } }],
      })
    )
    await sendChatMessage('draw a cat')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(useProjectsStore.getState().projects.find((p) => p.id === project.id)?.name).toBe(
      DEFAULT_PROJECT_NAME
    )
  })

  it('retries a rejected build through tool-result messages', async () => {
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat)
      .mockReturnValueOnce(
        replyHandle({
          text: 'Attempt one.',
          toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: UNDRAWABLE_SVG } }],
        })
      )
      .mockReturnValueOnce(
        replyHandle({
          text: 'Attempt two.',
          toolCalls: [{ toolCallId: 'c2', toolName: 'build_svg', input: { svg: VALID_SVG } }],
        })
      )
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2)
    // The retry conversation carries the failed attempt as assistant tool-call
    // + tool-result, so the model sees its own mistake.
    const retryMessages = vi.mocked(streamChat).mock.calls[1][0].messages
    const toolCallMsg = retryMessages.find((m) => m.role === 'assistant' && Array.isArray(m.content))
    expect(toolCallMsg?.content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'Attempt one.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'build_svg', input: { svg: UNDRAWABLE_SVG } },
      ])
    )
    const toolResultMsg = retryMessages.find((m) => m.role === 'tool')
    expect(toolResultMsg?.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'build_svg',
        output: {
          type: 'json',
          value: { ok: false, errors: [expect.stringContaining('drawable')] },
        },
      },
    ])
    expect(useEditorStore.getState().currentSvg).toContain('<rect')
  })

  it('accepts a text-only reply when artwork exists (lenient)', async () => {
    useEditorStore.getState().setSvg(VALID_SVG)
    vi.mocked(streamChat).mockReturnValue(replyHandle({ text: 'The artwork looks good as is.' }))
    await sendChatMessage('what do you think?')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1)
    const last = useChatStore.getState().messages.at(-1)
    expect(last?.streaming).toBe(false)
    expect(last?.outcome).toBeUndefined()
    expect(last?.text).toContain('looks good')
  })

  it('nudges then rejects text-only replies when artwork is required', async () => {
    vi.mocked(streamChat).mockReturnValue(replyHandle({ text: 'Sure, sounds nice.' }))
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3)
    const nudge = vi.mocked(streamChat).mock.calls[1][0].messages.at(-1)
    expect(nudge?.role).toBe('user')
    expect(nudge?.content).toContain('call exactly one tool')
    const last = useChatStore.getState().messages.at(-1)
    expect(last?.outcome).toBe('rejected')
    expect(useChatStore.getState().retryableIds).toContain(last?.id)
  })

  it('retries a reasoning-only stream with a corrective nudge, then succeeds', async () => {
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat)
      .mockReturnValueOnce(emptyResponseHandle())
      .mockReturnValueOnce(
        replyHandle({
          text: 'Here is the artwork.',
          toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG } }],
        })
      )
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2)
    // The retry conversation ends with an assistant placeholder + user nudge so
    // the model learns its reasoning-only reply produced nothing.
    const retryMessages = vi.mocked(streamChat).mock.calls[1][0].messages
    expect(retryMessages.at(-2)?.role).toBe('assistant')
    expect(retryMessages.at(-2)?.content).toContain('no visible output')
    expect(retryMessages.at(-1)?.role).toBe('user')
    expect(retryMessages.at(-1)?.content).toContain('reasoning')
    expect(useEditorStore.getState().currentSvg).toContain('<rect')
    expect(useChatStore.getState().retryableIds).toEqual([])
  })

  it('retries an abnormally empty stream result through the same nudge path', async () => {
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat)
      .mockReturnValueOnce(replyHandle({})) // stream resolved but nothing arrived
      .mockReturnValueOnce(
        replyHandle({
          text: 'Here is the artwork.',
          toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG } }],
        })
      )
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(streamChat).mock.calls[1][0].messages.at(-1)?.content).toContain('reasoning')
    expect(useEditorStore.getState().currentSvg).toContain('<rect')
  })

  it('fails after exhausting empty-response retries', async () => {
    vi.mocked(streamChat).mockReturnValue(emptyResponseHandle())
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(3)
    expect(useChatStore.getState().status).toBe('error')
    const last = useChatStore.getState().messages.at(-1)
    expect(last?.error).toContain('empty response')
    expect(useChatStore.getState().retryableIds).toContain(last?.id)
  })

  it('does not auto-retry other stream errors', async () => {
    vi.mocked(streamChat).mockReturnValue({
      cancel: () => {},
      promise: Promise.reject(new Error('auth: invalid api key')),
    })
    await sendChatMessage('draw a cat')

    expect(vi.mocked(streamChat)).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().status).toBe('error')
    expect(useChatStore.getState().lastError).toBe('auth: invalid api key')
  })

  it('stores plan steps, chips and attribute controls from a plan tool call', async () => {
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'My plan.',
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'propose_plan',
            input: {
              steps: [
                { id: 's1', label: 'Sky' },
                { id: 's2', label: 'Mountains' },
              ],
              attributes: [{ id: 'mood', label: 'Mood', type: 'text', defaultValue: 'calm' }],
            },
          },
        ],
      })
    )
    await sendChatMessage('draw a cat')

    const last = useChatStore.getState().messages.at(-1)
    expect(last?.outcome).toBe('plan')
    expect(last?.chips).toEqual([
      { id: 'confirm-draw', label: 'Looks good, draw it' },
      { id: 'request-changes', label: 'Request changes' },
    ])
    expect(last?.planSteps).toEqual([
      { id: 's1', label: 'Sky' },
      { id: 's2', label: 'Mountains' },
    ])
    expect(last?.attributeControls?.map((c) => c.id)).toEqual(['mood'])
    expect(useChatStore.getState().turnStage).toBe('await-confirm')
  })

  it('treats user text after a pending plan as a plan revision', async () => {
    await sendChatMessage('draw a cat') // planReply default -> propose_plan
    vi.mocked(streamChat).mockReturnValue(replyHandle({ text: 'Revised.' }))
    await sendChatMessage('make the palette warmer')

    const request = vi.mocked(streamChat).mock.calls[1][0]
    const sys = request.messages.find((m) => m.role === 'system')?.content
    expect(sys).toContain('STAGE: PLAN (REVISION)')
    const ctx = request.messages.find(
      (m) =>
        m.role === 'system' && typeof m.content === 'string' && m.content.includes('PLAN CHECKLIST (user-adjusted')
    )
    expect(ctx?.content).toContain('Sky')
  })

  it('feeds the user-adjusted checklist into the confirmed build turn', async () => {
    await sendChatMessage('draw a cat') // propose_plan with step "Sky"
    // User edits the checklist (rename), then confirms via the chip:
    // ChatPanel sets planConfirmed before dispatching the label.
    useChatStore.getState().setPlanStepEdit('s1', { included: true, label: 'Night sky' })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [{ toolCallId: 'c2', toolName: 'build_svg', input: { svg: VALID_SVG } }],
      })
    )
    await sendChatMessage('Looks good, draw it')

    const request = vi.mocked(streamChat).mock.calls[1][0]
    const ctx = request.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('CONFIRMED PLAN STEPS (overrides')
    )
    expect(ctx?.content).toContain('Night sky')
    expect(ctx?.content).toContain('Checklist adjustments: change "Sky" to "Night sky".')
    expect(useEditorStore.getState().currentSvg).toContain('<rect')
  })

  it('keeps checklist edits effective when the model omits step ids', async () => {
    // Models often omit ids despite the schema; the dispatch synthesizes
    // step-N so edits still key correctly instead of collapsing onto ''.
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'My plan.',
        toolCalls: [
          {
            toolCallId: 'c1',
            toolName: 'propose_plan',
            input: { steps: [{ label: 'Sky' }, { label: 'Mountains' }] },
          },
        ],
      })
    )
    await sendChatMessage('draw a cat')

    const plan = useChatStore.getState().messages.at(-1)
    expect(plan?.planSteps?.map((s) => s.id)).toEqual(['step-1', 'step-2'])

    // The user excludes the second step, then confirms.
    useChatStore.getState().setPlanStepEdit('step-2', { included: false, label: 'Mountains' })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [{ toolCallId: 'c2', toolName: 'build_svg', input: { svg: VALID_SVG } }],
      })
    )
    await sendChatMessage('Looks good, draw it')

    const request = vi.mocked(streamChat).mock.calls[1][0]
    const ctx = request.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('CONFIRMED PLAN STEPS (overrides')
    )
    // The step list carries only the kept step; the exclusion is named in the
    // adjustments line so the model cannot miss it.
    expect(ctx?.content).toContain(': 1. Sky')
    expect(ctx?.content).toContain('Checklist adjustments: skip "Mountains".')
  })

  it('keeps edits effective on legacy plans persisted before id normalization', async () => {
    await sendChatMessage('draw a cat') // default planReply lands a plan reply
    // Rewrite the payload the way the pre-normalization code persisted it:
    // steps with empty ids straight from the model output.
    const planId = useChatStore.getState().messages.at(-1)!.id
    useChatStore.getState().setAssistantPayload(planId, {
      planSteps: [
        { id: '', label: 'Sky' },
        { id: '', label: 'Mountains' },
      ],
    })
    // The user excludes the second step; the UI keys by the read-side
    // synthesized id (annotatePlanSteps normalizes before overlaying).
    useChatStore.getState().setPlanStepEdit('step-2', { included: false, label: 'Mountains' })
    useChatStore.getState().setPlanConfirmed(true)
    vi.mocked(streamChat).mockReturnValue(
      replyHandle({
        text: 'Here is the artwork.',
        toolCalls: [{ toolCallId: 'c2', toolName: 'build_svg', input: { svg: VALID_SVG } }],
      })
    )
    await sendChatMessage('Looks good, draw it')

    const request = vi.mocked(streamChat).mock.calls[1][0]
    const ctx = request.messages.find(
      (m) =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.includes('CONFIRMED PLAN STEPS (overrides')
    )
    // The step list carries only the kept step; the exclusion is named in the
    // adjustments line so the model cannot miss it.
    expect(ctx?.content).toContain(': 1. Sky')
    expect(ctx?.content).toContain('Checklist adjustments: skip "Mountains".')
  })
})
