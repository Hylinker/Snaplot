import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore, annotatePlanSteps, findLatestPlan, findTurnUserIndex } from '../chat'
import { useEditorStore } from '../editor'
import { useSettingsStore } from '../settings'
import { snapshotContent } from '../projects'
import { emptyProjectContent } from '../../types'

describe('settings store', () => {
  it('isConfigured requires baseUrl and model', () => {
    useSettingsStore.setState({ baseUrl: '', model: '' })
    expect(useSettingsStore.getState().isConfigured()).toBe(false)
    useSettingsStore.getState().setSettings({ baseUrl: 'https://x', model: 'm' })
    expect(useSettingsStore.getState().isConfigured()).toBe(true)
  })

  it('trims whitespace from provider fields and rejects whitespace-only values', () => {
    useSettingsStore.getState().setSettings({ baseUrl: '  https://x  ', model: '  ', apiKey: ' k ' })
    expect(useSettingsStore.getState().baseUrl).toBe('https://x')
    expect(useSettingsStore.getState().apiKey).toBe('k')
    // A whitespace-only model is empty after trimming.
    expect(useSettingsStore.getState().isConfigured()).toBe(false)
  })
})

describe('chat store', () => {
  beforeEach(() => useChatStore.getState().clear())

  it('appends user and assistant messages', () => {
    useChatStore.getState().appendUser('hello')
    const id = useChatStore.getState().beginAssistant()
    expect(useChatStore.getState().status).toBe('streaming')
    useChatStore.getState().appendAssistantDelta(id, 'one\n```svg\n<svg/>\n```\ntwo')
    const msg = useChatStore.getState().messages.find((m) => m.id === id)!
    expect(msg.raw).toContain('```svg')
    expect(msg.text).not.toContain('```svg') // fenced blocks stripped for display
    expect(msg.text).toContain('one')
    useChatStore.getState().finishAssistant(id, 'artwork-updated')
    expect(useChatStore.getState().messages.find((m) => m.id === id)?.outcome).toBe('artwork-updated')
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('records failures and retryability', () => {
    const id = useChatStore.getState().beginAssistant()
    useChatStore.getState().failAssistant(id, 'boom')
    useChatStore.getState().markRetryable(id, true)
    expect(useChatStore.getState().status).toBe('error')
    expect(useChatStore.getState().lastError).toBe('boom')
    expect(useChatStore.getState().retryableIds).toContain(id)
  })

  it('stores image attachments on user messages and keeps them through hydrate', () => {
    useChatStore.getState().appendUser('look', undefined, ['data:image/png;base64,AAA'])
    useChatStore.getState().appendUser('plain')
    const messages = useChatStore.getState().messages
    expect(messages[0].images).toEqual(['data:image/png;base64,AAA'])
    expect(messages[1].images).toBeUndefined()

    const content = { ...emptyProjectContent(), messages }
    useChatStore.getState().clear()
    useChatStore.getState().hydrate(content)
    expect(useChatStore.getState().messages[0].images).toEqual(['data:image/png;base64,AAA'])
  })

  it('attaches tool-turn payloads (chips, controls, activity) to replies', () => {
    const id = useChatStore.getState().beginAssistant()
    const chips = [
      { id: 'a', label: 'A' },
      { id: 'confirm-draw', label: 'Draw it' },
    ]
    useChatStore.getState().setAssistantPayload(id, { chips })
    useChatStore.getState().setAssistantTool(id, 'build_svg')
    let msg = useChatStore.getState().messages.find((m) => m.id === id)!
    expect(msg.chips).toEqual(chips)
    expect(msg.toolActive).toBe('build_svg')

    useChatStore.getState().setAssistantTool(id, null)
    msg = useChatStore.getState().messages.find((m) => m.id === id)!
    expect(msg.toolActive).toBeNull()
    expect(useChatStore.getState().status).toBe('streaming')
  })

  it('attaches plan steps to a plan reply payload', () => {
    const id = useChatStore.getState().beginAssistant()
    const planSteps = [
      { id: 's1', label: 'Sky' },
      { id: 's2', label: 'Mountains' },
    ]
    useChatStore.getState().setAssistantPayload(id, { planSteps })
    expect(useChatStore.getState().messages.find((m) => m.id === id)?.planSteps).toEqual(planSteps)
  })

  it('withdraw removes the turn user message, the reply, and everything after', () => {
    const turn1 = useChatStore.getState().appendUser('draw a cat')
    const reply = useChatStore.getState().beginAssistant()
    useChatStore.getState().finishAssistant(reply, 'artwork-updated')
    const review = useChatStore.getState().beginAssistant() // standalone visual review
    useChatStore.getState().finishAssistant(review)
    useChatStore.getState().appendUser('make it blue')
    const reply2 = useChatStore.getState().beginAssistant()
    useChatStore.getState().finishAssistant(reply2, 'artwork-updated')

    useChatStore.getState().withdraw(reply2)
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([turn1.id, reply, review])
  })

  it('withdraw removes only a standalone reply (manual visual review)', () => {
    const turn1 = useChatStore.getState().appendUser('draw a cat')
    const reply = useChatStore.getState().beginAssistant()
    useChatStore.getState().finishAssistant(reply, 'artwork-updated')
    const review = useChatStore.getState().beginAssistant() // no user message of its own
    useChatStore.getState().finishAssistant(review)
    const turn2 = useChatStore.getState().appendUser('make it blue')
    const reply2 = useChatStore.getState().beginAssistant()
    useChatStore.getState().finishAssistant(reply2, 'artwork-updated')

    const svgBefore = useChatStore.getState().withdraw(review)
    expect(svgBefore).toBeUndefined() // reviews never snapshot the canvas
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
      turn1.id,
      reply,
      turn2.id,
      reply2,
    ])
  })

  it('withdraw removes only the first of consecutive standalone replies', () => {
    const turn1 = useChatStore.getState().appendUser('draw a cat')
    const reply = useChatStore.getState().beginAssistant()
    const review1 = useChatStore.getState().beginAssistant()
    const review2 = useChatStore.getState().beginAssistant()

    useChatStore.getState().withdraw(review1)
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([turn1.id, reply, review2])
  })

  it('withdraw cleans retryable ids of removed messages', () => {
    useChatStore.getState().appendUser('draw a cat')
    const reply = useChatStore.getState().beginAssistant()
    useChatStore.getState().markRetryable(reply, true)
    useChatStore.getState().withdraw(reply)
    expect(useChatStore.getState().retryableIds).toEqual([])
  })

  it('findTurnUserIndex returns -1 for standalone replies and the turn user otherwise', () => {
    const turn1 = useChatStore.getState().appendUser('draw a cat')
    useChatStore.getState().beginAssistant()
    useChatStore.getState().beginAssistant() // standalone visual review
    const messages = useChatStore.getState().messages
    expect(findTurnUserIndex(messages, 2)).toBe(-1)
    expect(findTurnUserIndex(messages, 1)).toBe(0)
    expect(messages[0].id).toBe(turn1.id)
  })
})

describe('plan checklist edits', () => {
  beforeEach(() => useChatStore.getState().clear())

  it('annotatePlanSteps overlays renames and exclusions, defaulting to included', () => {
    const steps = [
      { id: 's1', label: 'Sky' },
      { id: 's2', label: 'Mountains' },
      { id: 's3', label: 'Sun' },
    ]
    expect(annotatePlanSteps(steps, {})).toEqual([
      { id: 's1', label: 'Sky', included: true },
      { id: 's2', label: 'Mountains', included: true },
      { id: 's3', label: 'Sun', included: true },
    ])
    expect(
      annotatePlanSteps(steps, { s2: { included: false, label: 'Peaks' }, s3: { included: true, label: 'Glowing sun' } })
    ).toEqual([
      { id: 's1', label: 'Sky', included: true },
      { id: 's2', label: 'Peaks', included: false },
      { id: 's3', label: 'Glowing sun', included: true },
    ])
  })

  it('annotatePlanSteps normalizes legacy empty ids so edits key per step', () => {
    const legacy = [
      { id: '', label: 'Sky' },
      { id: '', label: 'Mountains' },
      { id: '', label: 'Sun' },
    ]
    expect(annotatePlanSteps(legacy, { 'step-2': { included: false, label: 'Peaks' } })).toEqual([
      { id: 'step-1', label: 'Sky', included: true },
      { id: 'step-2', label: 'Peaks', included: false },
      { id: 'step-3', label: 'Sun', included: true },
    ])
  })

  it('setPlanStepEdit / resetPlanStepEdits manage the edit map', () => {
    const s = useChatStore.getState()
    s.setPlanStepEdit('s1', { included: false, label: 'Sky' })
    expect(useChatStore.getState().planStepEdits).toEqual({ s1: { included: false, label: 'Sky' } })
    s.resetPlanStepEdits()
    expect(useChatStore.getState().planStepEdits).toEqual({})
  })

  it('markChipUsed records clicked chips without duplicates', () => {
    const id = useChatStore.getState().beginAssistant()
    const s = useChatStore.getState()
    s.markChipUsed(id, 'confirm-draw')
    s.markChipUsed(id, 'confirm-draw')
    s.markChipUsed(id, 'request-changes')
    expect(useChatStore.getState().messages.find((m) => m.id === id)?.chipsUsed).toEqual([
      'confirm-draw',
      'request-changes',
    ])
  })

  it('findLatestPlan finds the newest structured plan or legacy confirm chip', () => {
    const plan = useChatStore.getState().beginAssistant()
    useChatStore.getState().setAssistantPayload(plan, { planSteps: [{ id: 's1', label: 'Sky' }] })
    useChatStore.getState().finishAssistant(plan)
    const question = useChatStore.getState().beginAssistant()
    useChatStore.getState().setAssistantPayload(question, { chips: [{ id: 'a', label: 'A' }] })
    useChatStore.getState().finishAssistant(question)
    const messages = useChatStore.getState().messages

    // Questions after the plan do not supersede it.
    expect(findLatestPlan(messages)?.id).toBe(plan)

    const legacy = useChatStore.getState().beginAssistant()
    useChatStore.getState().setAssistantPayload(legacy, {
      chips: [{ id: 'confirm-draw', label: 'Looks good, draw it' }],
    })
    useChatStore.getState().finishAssistant(legacy)
    expect(findLatestPlan(useChatStore.getState().messages)?.id).toBe(legacy)

    expect(findLatestPlan([])).toBeNull()
  })

  it('hydrate restores plan step edits and legacy records default to none', () => {
    useChatStore.getState().setPlanStepEdit('s1', { included: false, label: 'x' })
    useChatStore.getState().hydrate({
      ...emptyProjectContent(),
      planStepEdits: { s2: { included: true, label: 'renamed' } },
    })
    expect(useChatStore.getState().planStepEdits).toEqual({ s2: { included: true, label: 'renamed' } })

    const legacy = emptyProjectContent()
    delete legacy.planStepEdits
    useChatStore.getState().hydrate(legacy)
    expect(useChatStore.getState().planStepEdits).toEqual({})
  })

  it('snapshotContent carries plan step edits into the persisted record', () => {
    useChatStore.getState().setPlanStepEdit('s1', { included: false, label: 'x' })
    expect(snapshotContent().planStepEdits).toEqual({ s1: { included: false, label: 'x' } })
  })
})

describe('composer draft', () => {
  beforeEach(() => useChatStore.getState().clear())

  it('setDraft updates the draft', () => {
    useChatStore.getState().setDraft('a red circle')
    expect(useChatStore.getState().draft).toBe('a red circle')
  })

  it('hydrate restores the persisted draft and falls back on legacy records', () => {
    useChatStore.getState().setDraft('outgoing')
    useChatStore.getState().hydrate({ ...emptyProjectContent(), draft: 'saved draft' })
    expect(useChatStore.getState().draft).toBe('saved draft')

    const legacy = emptyProjectContent()
    delete legacy.draft
    useChatStore.getState().hydrate(legacy)
    expect(useChatStore.getState().draft).toBe('')
  })

  it('clear resets the draft', () => {
    useChatStore.getState().setDraft('pending text')
    useChatStore.getState().clear()
    expect(useChatStore.getState().draft).toBe('')
  })

  it('snapshotContent carries the draft into the persisted project record', () => {
    useChatStore.getState().setDraft('per-project draft')
    expect(snapshotContent().draft).toBe('per-project draft')
  })
})

describe('editor store', () => {
  beforeEach(() => useEditorStore.getState().clear())

  it('bumps revision on setSvg', () => {
    const r0 = useEditorStore.getState().revision
    useEditorStore.getState().setSvg('<svg/>')
    expect(useEditorStore.getState().revision).toBe(r0 + 1)
    expect(useEditorStore.getState().currentSvg).toBe('<svg/>')
  })

  it('syncSelectionAfterEdit clears selection when target is gone', () => {
    const s = useEditorStore.getState()
    s.setSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1"/></svg>')
    s.setSelection({ id: 'el-1', tagName: 'rect', attributes: {} })
    s.syncSelectionAfterEdit('<svg xmlns="http://www.w3.org/2000/svg"><circle id="el-2"/></svg>')
    expect(useEditorStore.getState().selection).toBeNull()
  })

  it('syncSelectionAfterEdit keeps selection when target survives', () => {
    const s = useEditorStore.getState()
    s.setSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1" fill="red"/></svg>')
    s.setSelection({ id: 'el-1', tagName: 'rect', attributes: { fill: 'red' } })
    s.syncSelectionAfterEdit('<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1" fill="blue"/></svg>')
    expect(useEditorStore.getState().selection?.id).toBe('el-1')
  })

  it('syncCanvasSvg updates state without a reload-triggering revision bump', () => {
    const s = useEditorStore.getState()
    s.setSvg('<svg id="a"/>')
    const r0 = useEditorStore.getState().revision
    s.syncCanvasSvg('<svg id="manual"/>')
    expect(useEditorStore.getState().currentSvg).toBe('<svg id="manual"/>')
    expect(useEditorStore.getState().revision).toBe(r0) // no reload
  })

  it('clear resets everything', () => {
    useEditorStore.getState().setSvg('<svg/>')
    useEditorStore.getState().clear()
    expect(useEditorStore.getState().currentSvg).toBeNull()
    expect(useEditorStore.getState().revision).toBe(0)
  })

  it('flushLiveCanvas invokes the registered implementation and clears with null', () => {
    const calls: number[] = []
    useEditorStore.getState().registerFlushLiveCanvas(() => calls.push(1))
    useEditorStore.getState().flushLiveCanvas()
    expect(calls).toEqual([1])
    useEditorStore.getState().registerFlushLiveCanvas(null)
    // No implementation: a no-op, never a throw.
    useEditorStore.getState().flushLiveCanvas()
    expect(calls).toEqual([1])
  })
})
