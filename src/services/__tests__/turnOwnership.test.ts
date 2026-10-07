import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendChatMessage } from '../agentRunner'
import { streamChat, type StreamResult } from '../streamClient'
import { useChatStore } from '../../stores/chat'
import { useEditorStore } from '../../stores/editor'
import { useSettingsStore } from '../../stores/settings'
import { useProjectsStore } from '../../stores/projects'

vi.mock('../streamClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../streamClient')>()),
  streamChat: vi.fn(),
}))

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'

const buildReply = {
  text: 'Here is the artwork.',
  toolCalls: [{ toolCallId: 'c1', toolName: 'build_svg', input: { svg: VALID_SVG } }],
} as StreamResult

/** A stream whose result is settled later by the test. */
function deferredStream() {
  let resolve!: (r: StreamResult) => void
  let reject!: (e: Error) => void
  const promise = new Promise<StreamResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    handle: { cancel: vi.fn(), promise },
    settle: () => resolve(buildReply),
    abort: () => {
      const e = new Error('The operation was aborted')
      e.name = 'AbortError'
      reject(e)
    },
  }
}

/** Let pending microtasks (turn start, stream start) run. */
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('chat store cancel/interrupt semantics (audit N6)', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('cancelActive is a no-op outside a stream', () => {
    useChatStore.getState().setCancel(() => {})
    useChatStore.getState().cancelActive()
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('cancelActive clears the cancel handle mid-stream', () => {
    useChatStore.getState().beginAssistant() // sets status streaming
    useChatStore.getState().setCancel(() => {})
    useChatStore.getState().cancelActive()
    expect(useChatStore.getState().cancel).toBeNull()
    expect(useChatStore.getState().status).toBe('canceled')
  })

  it('interruptAssistant keeps partial text, marks retryable, sets no error', () => {
    const id = useChatStore.getState().beginAssistant()
    useChatStore.getState().appendAssistantDelta(id, 'partial reply')
    useChatStore.getState().interruptAssistant(id)
    const s = useChatStore.getState()
    expect(s.status).toBe('idle')
    expect(s.lastError).toBeNull()
    expect(s.retryableIds).toContain(id)
    const last = s.messages.at(-1)!
    expect(last.streaming).toBe(false)
    expect(last.error).toBeUndefined()
    expect(last.text).toBe('partial reply')
  })

  it('interruptAssistant ignores messages that no longer exist', () => {
    useChatStore.getState().interruptAssistant('ghost-id')
    expect(useChatStore.getState().retryableIds).toEqual([])
  })
})

describe('turn ownership across project transitions (audit A1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    useChatStore.getState().clear()
    useEditorStore.getState().clear()
    useSettingsStore.setState({
      baseUrl: 'https://example.com/v1',
      apiKey: 'key',
      model: 'main-model',
      visionModel: '',
      visualReviewMode: 'never',
    })
    await useProjectsStore.getState().init()
  })

  it('a user cancel does not surface as an error', async () => {
    const stream = deferredStream()
    vi.mocked(streamChat).mockReturnValue(stream.handle)
    useChatStore.getState().setPlanConfirmed(true)

    const turn = sendChatMessage('draw a cat')
    await tick()
    expect(useChatStore.getState().status).toBe('streaming')

    useChatStore.getState().cancelActive()
    stream.abort()
    await turn

    const s = useChatStore.getState()
    expect(s.status).toBe('idle')
    expect(s.lastError).toBeNull()
    const last = s.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.streaming).toBe(false)
    expect(last.error).toBeUndefined()
    expect(s.retryableIds).toContain(last.id)
  })

  it('a stale turn cannot apply artwork to the newly active project', async () => {
    const projectA = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().create('B')
    const projectB = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().switchTo(projectA)

    const stream = deferredStream()
    vi.mocked(streamChat).mockReturnValue(stream.handle)
    useChatStore.getState().setPlanConfirmed(true)

    const turn = sendChatMessage('draw a cat')
    await tick()
    expect(useChatStore.getState().status).toBe('streaming')

    await useProjectsStore.getState().switchTo(projectB)
    stream.settle()
    await turn

    // Project B's stores were hydrated empty; the old turn's build must not
    // land in them.
    expect(useProjectsStore.getState().activeProjectId).toBe(projectB)
    expect(useEditorStore.getState().currentSvg).toBeNull()
    expect(useChatStore.getState().messages).toHaveLength(0)
    expect(useChatStore.getState().planConfirmed).toBe(false)
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('switching projects cancels the in-flight stream', async () => {
    await useProjectsStore.getState().create('B')
    const projectB = useProjectsStore.getState().activeProjectId!
    await useProjectsStore.getState().switchTo(
      useProjectsStore.getState().projects.find((p) => p.id !== projectB)!.id
    )

    const stream = deferredStream()
    vi.mocked(streamChat).mockReturnValue(stream.handle)
    useChatStore.getState().setPlanConfirmed(true)

    const turn = sendChatMessage('draw a cat')
    await tick()

    await useProjectsStore.getState().switchTo(projectB)
    expect(stream.handle.cancel).toHaveBeenCalled()

    stream.settle()
    await turn
    expect(useEditorStore.getState().currentSvg).toBeNull()
  })

  it('creating a project cancels the in-flight stream of the outgoing one', async () => {
    const stream = deferredStream()
    vi.mocked(streamChat).mockReturnValue(stream.handle)
    useChatStore.getState().setPlanConfirmed(true)

    const turn = sendChatMessage('draw a cat')
    await tick()

    await useProjectsStore.getState().create('New project')
    expect(stream.handle.cancel).toHaveBeenCalled()

    stream.settle()
    await turn
    expect(useEditorStore.getState().currentSvg).toBeNull()
  })
})
