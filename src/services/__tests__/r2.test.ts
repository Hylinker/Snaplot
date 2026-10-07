import { describe, expect, it } from 'vitest'
import {
  buildRequestMessages,
  buildSystemPrompt,
  boundSvg,
  boundHistory,
  selectionSnippet,
  HISTORY_MAX_MESSAGES,
  SVG_MAX_BYTES,
} from '../promptBuilder'
import { validateAttributeControls, applyDefaults, MAX_CONTROLS } from '../../svg/attributes'
import { validateChoices } from '../../svg/choices'

describe('promptBuilder (agent turn workflow)', () => {
  const base = {
    history: [{ role: 'user' as const, content: 'hi' }],
    currentSvg: null,
    selection: null,
    attributeValues: {},
  }

  it('system prompt contains the tool-calling contract and behavior rules', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'implement' })
    expect(sys).toContain('exactly ONE action')
    expect(sys).toContain('Exactly one tool call per reply')
    expect(sys).toContain('apply_edits')
    expect(sys).toContain('never with text only')
    expect(sys).toContain("same language as the user's messages")
  })

  it('system prompt states the sanitizer limits', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'implement' })
    expect(sys).toContain('<style> blocks and CSS class rules are stripped')
    expect(sys).toContain('data: URIs')
    expect(sys).toContain('generic font families')
  })

  it('plan stage directive comes first and asks for the plan tool', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'plan' })
    expect(sys.indexOf('STAGE: PLAN')).toBeGreaterThanOrEqual(0)
    expect(sys.indexOf('STAGE: PLAN')).toBeLessThan(sys.indexOf('You are Snaplot'))
    expect(sys).toContain('design plan')
    expect(sys).toContain('confirm')
    expect(sys).toContain('propose_plan')
  })

  it('plan revision directive replaces the first-plan directive on feedback turns', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'plan', planRevision: true })
    expect(sys).toContain('STAGE: PLAN (REVISION)')
    expect(sys).toContain('Revise the plan')
    expect(sys).toContain('reuse step ids and labels')
    // A typed confirmation must not trigger a redesign.
    expect(sys).toContain('plain confirmation with no change requested')
    expect(sys).not.toContain('No confirmed artwork yet')
  })

  it('injects the user-adjusted checklist as the authoritative revision baseline (plan stage)', () => {
    const { messages } = buildRequestMessages({
      ...base,
      stage: 'plan',
      planRevision: true,
      planSteps: [
        { id: 's1', label: 'Sky' },
        { id: 's2', label: 'Peaks' },
      ],
    })
    const ctx = messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('PLAN CHECKLIST (user-adjusted')
    )
    expect(ctx?.content).toContain('authoritative baseline')
    expect(ctx?.content).toContain('never reintroduce an excluded step')
    expect(ctx?.content).toContain('1. Sky; 2. Peaks')
  })

  it('injects confirmed plan steps with override wording (implement stage)', () => {
    const { messages } = buildRequestMessages({
      ...base,
      stage: 'implement',
      planSteps: [
        { id: 's1', label: 'Sky' },
        { id: 's2', label: 'Peaks' },
      ],
      planAdjustments: 'change "Peaks" to "Summits"',
    })
    const ctx = messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('CONFIRMED PLAN STEPS (overrides')
    )
    expect(ctx?.content).toContain('overrides the step list in your earlier plan text')
    expect(ctx?.content).toContain('following exactly this list')
    expect(ctx?.content).toContain('must not appear in the artwork')
    expect(ctx?.content).toContain('Checklist adjustments: change "Peaks" to "Summits".')
    // The stage directive cross-references the checklist so it cannot be missed.
    const sys = messages.find((m) => m.role === 'system')?.content
    expect(sys).toContain('Follow the CONFIRMED PLAN STEPS')
  })

  it('omits the confirmed-steps cross-reference when no plan steps are known', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'implement' })
    expect(sys).not.toContain('Follow the CONFIRMED PLAN STEPS')
  })

  it('never injects plan steps once artwork exists', () => {
    const { messages } = buildRequestMessages({
      ...base,
      stage: 'implement',
      currentSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      planSteps: [{ id: 's1', label: 'Sky' }],
    })
    expect(
      messages.some((m) => typeof m.content === 'string' && m.content.includes('CONFIRMED PLAN STEPS'))
    ).toBe(false)
  })

  it('implement stage with artwork asks for edit operations', () => {
    const sys = buildSystemPrompt({
      ...base,
      stage: 'implement',
      currentSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    expect(sys).toContain('STAGE: IMPLEMENT')
    expect(sys).toContain('EDIT instruction')
    expect(sys).toContain('apply_edits')
    expect(sys).not.toContain('STAGE: PLAN')
  })

  it('implement stage without artwork asks for the build tool', () => {
    const sys = buildSystemPrompt({ ...base, stage: 'implement' })
    expect(sys).toContain('build_svg')
    expect(sys).toContain('complete <svg> document')
    // The first build also names the project via the optional title field.
    expect(sys).toContain('"name"')
    expect(sys).toContain('project title')
  })

  it('includes bounded current SVG and selection in context', () => {
    const { messages } = buildRequestMessages({
      ...base,
      stage: 'implement',
      currentSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1"/></svg>',
      selection: { id: 'el-1', tagName: 'rect', attributes: { fill: '#123' } },
    })
    const ctx = messages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('CURRENT ARTWORK')
    )
    expect(ctx?.content).toContain('el-1')
    // The artwork is embedded fence-free so the model cannot echo it as output.
    expect(ctx?.content).not.toContain('```')
    const sel = messages.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('SELECTED ELEMENT')
    )
    expect(sel?.content).toContain('<rect fill="#123"')
  })

  it('includes active attribute values', () => {
    const { messages } = buildRequestMessages({
      ...base,
      stage: 'implement',
      attributeValues: { mood: 'calm' },
    })
    expect(
      messages.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('ACTIVE ATTRIBUTE VALUES') &&
          (m.content.includes('mood="calm"') || m.content.includes('"calm"'))
      )
    ).toBe(true)
  })

  it('adds an attached-images context line only when history carries image parts', () => {
    const multimodal = buildRequestMessages({
      ...base,
      stage: 'implement',
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'like this' },
            { type: 'image', image: 'data:image/png;base64,AAA' },
          ],
        },
      ],
    })
    expect(
      multimodal.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('ATTACHED IMAGES')
      )
    ).toBe(true)
    expect(
      multimodal.messages.some((m) => m.content === 'like this')
    ).toBe(false) // parts pass through, not flattened

    const plain = buildRequestMessages({ ...base, stage: 'implement' })
    expect(
      plain.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('ATTACHED IMAGES')
      )
    ).toBe(false)
  })

  it('passes multimodal history through boundHistory unchanged', () => {
    const parts = [
      { type: 'text' as const, text: 'like this' },
      { type: 'image' as const, image: 'data:image/png;base64,AAA' },
    ]
    const bounded = boundHistory([{ role: 'user', content: parts }])
    expect(bounded[0].content).toBe(parts)
  })

  it('bounds history to the last N messages', () => {
    const history = Array.from({ length: HISTORY_MAX_MESSAGES + 10 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }))
    const bounded = boundHistory(history)
    expect(bounded.length).toBe(HISTORY_MAX_MESSAGES)
    expect(bounded[bounded.length - 1].content).toBe(`m${history.length - 1}`)
  })

  it('boundSvg keeps the document valid under the byte budget', () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(50000)}</svg>`
    const bounded = boundSvg(huge, 1000)
    expect(bounded.length).toBeLessThanOrEqual(1100)
    const doc = new DOMParser().parseFromString(bounded, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
  })

  it('boundSvg passes through small documents unchanged', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
    expect(boundSvg(svg)).toBe(svg)
    expect(svg.length).toBeLessThanOrEqual(SVG_MAX_BYTES)
  })

  it('selection snippet truncates attributes', () => {
    const long: Record<string, string> = {}
    for (let i = 0; i < 30; i++) long[`attr${i}`] = 'x'.repeat(60)
    const snippet = selectionSnippet({ id: 'a', tagName: 'rect', attributes: long })
    expect(snippet!.length).toBeLessThanOrEqual(400)
  })
})

describe('validateAttributeControls', () => {
  const ok = (over: Record<string, unknown>) => ({
    id: 'c1',
    label: 'C',
    type: 'text',
    defaultValue: 'x',
    ...over,
  })

  it('accepts valid controls of each type', () => {
    const controls = validateAttributeControls({
      attributes: [
        ok({ id: 'a', type: 'text' }),
        ok({ id: 'b', type: 'number', defaultValue: 3 }),
        ok({ id: 'c', type: 'boolean', defaultValue: true }),
        ok({ id: 'd', type: 'color', defaultValue: '#fff' }),
        ok({
          id: 'e',
          type: 'select',
          defaultValue: 'A',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        }),
      ],
    })
    expect(controls.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('ignores invalid controls individually', () => {
    const controls = validateAttributeControls({
      attributes: [
        { label: 'no id', type: 'text', defaultValue: 'x' },
        ok({ id: 'x', type: 'bogus' }),
        ok({ id: 'y', type: 'select', options: [{ id: 'only', label: 'One' }] }), // <2 options
        { id: 'dup', label: 'L', type: 'text', defaultValue: 'x' },
        ok({ id: 'dup', label: 'L2', type: 'text', defaultValue: 'y' }),
        ok({ id: 'n', type: 'number', defaultValue: 'NaN-ish' }),
        ok({ id: 'good', type: 'textarea', defaultValue: '' }),
      ],
    })
    expect(controls.map((c) => c.id)).toEqual(['dup', 'good'])
  })

  it('caps controls at 12 and validates number ranges', () => {
    const many = Array.from({ length: 20 }, (_, i) => ok({ id: `c${i}` }))
    expect(validateAttributeControls({ attributes: many }).length).toBe(MAX_CONTROLS)
    const badRange = validateAttributeControls({
      attributes: [ok({ id: 'r', type: 'number', defaultValue: 1, min: 5, max: 2 })],
    })
    expect(badRange).toEqual([])
  })

  it('applyDefaults overlays user values', () => {
    const controls = validateAttributeControls({
      attributes: [ok({ id: 'a', type: 'text', defaultValue: 'dflt' })],
    })
    expect(applyDefaults(controls, {})).toEqual({ a: 'dflt' })
    expect(applyDefaults(controls, { a: 'user' })).toEqual({ a: 'user' })
  })
})

describe('validateChoices', () => {
  it('accepts a valid block', () => {
    const block = validateChoices({
      questionId: 'mood',
      prompt: 'Choose a mood',
      choices: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    })
    expect(block?.choices.length).toBe(2)
  })

  it('rejects malformed blocks', () => {
    expect(validateChoices(null)).toBeNull()
    expect(validateChoices({ questionId: 'x', prompt: 'p', choices: [{ id: 'a', label: 'A' }] })).toBeNull()
    expect(validateChoices({ prompt: 'p', choices: [] })).toBeNull()
    expect(
      validateChoices({ questionId: 'x', prompt: 'p', choices: [{ id: 'a', label: 'A' }, { id: '', label: 'B' }] })
    ).toBeNull()
  })
})
