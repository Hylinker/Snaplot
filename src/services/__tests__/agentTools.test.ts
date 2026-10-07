import { describe, expect, it } from 'vitest'
import {
  actionFromToolCall,
  AGENT_TOOL_DECLARATIONS,
  toolResultOutput,
  toolsForStage,
} from '../agentTools'

const call = (toolName: string, input: unknown) => ({ toolCallId: 'call-1', toolName, input })

describe('AGENT_TOOL_DECLARATIONS', () => {
  it('declares the four tools with schemas', () => {
    const names = AGENT_TOOL_DECLARATIONS.map((t) => t.name)
    expect(names).toEqual(['build_svg', 'apply_edits', 'ask_question', 'propose_plan'])
    for (const t of AGENT_TOOL_DECLARATIONS) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.parameters.type).toBe('object')
    }
    const build = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'build_svg')!
    expect(build.parameters.required).toEqual(['svg'])
    const edits = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'apply_edits')!
    expect(edits.parameters.required).toEqual(['operations'])
  })

  it('documents the required fields of every edit operation on apply_edits', () => {
    // The tool description is the model's only schema source — omitting a field
    // there is the top source of "operations[N].element: required" rejections.
    const edits = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'apply_edits')!
    for (const shape of [
      '"type":"setRoot"',
      '"type":"setAttributes"',
      '"type":"insertElement"',
      '"type":"removeElement"',
      '"type":"replaceElement"',
      '"type":"setFullSvg"',
      '"element":"<rect',
    ]) {
      expect(edits.description).toContain(shape)
    }
  })

  it('declares a discriminating JSON schema for apply_edits operations', () => {
    // A loose items:{type:"object"} lets models omit "type" (or invent one),
    // which fails verification and triggers a narrated retry.
    const edits = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'apply_edits')!
    const parameters = edits.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, unknown>
    const operations = properties.operations as Record<string, unknown>
    const operationItems = operations.items as Record<string, unknown>
    const variants = (operationItems.oneOf as {
      properties: { type: { enum: string[] } }
      required: string[]
    }[]).map((v) => ({ type: v.properties.type.enum[0], required: v.required }))
    expect(variants.map((v) => v.type).sort()).toEqual(
      ['insertElement', 'removeElement', 'replaceElement', 'setAttributes', 'setFullSvg', 'setRoot'].sort()
    )
    for (const v of variants) expect(v.required).toContain('type')
    // setRoot applies to the root element, so it must not demand a target.
    expect(variants.find((v) => v.type === 'setRoot')?.required).not.toContain('target')
  })

  it('carries the sanitizer constraints on build_svg', () => {
    const build = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'build_svg')!
    expect(build.description).toContain('<style> blocks and CSS class rules are stripped')
    expect(build.description).toContain('data: URIs')
  })

  it('declares the optional project title on build_svg without requiring it', () => {
    const build = AGENT_TOOL_DECLARATIONS.find((t) => t.name === 'build_svg')!
    expect(build.parameters.properties).toHaveProperty('name')
    expect(build.parameters.required).toEqual(['svg'])
  })
})

describe('toolsForStage', () => {
  it('offers the plan tool before any artwork exists', () => {
    expect(toolsForStage('plan', false).map((t) => t.name)).toEqual([
      'propose_plan',
      'ask_question',
    ])
  })

  it('offers build when implementing without artwork', () => {
    expect(toolsForStage('implement', false).map((t) => t.name)).toEqual([
      'build_svg',
      'ask_question',
    ])
  })

  it('offers edits (plus full rebuild) when artwork exists', () => {
    expect(toolsForStage('implement', true).map((t) => t.name)).toEqual([
      'build_svg',
      'apply_edits',
      'ask_question',
    ])
  })
})

describe('actionFromToolCall', () => {
  it('maps build_svg to a build action', () => {
    const r = actionFromToolCall(call('build_svg', { svg: '<svg/>' }))
    expect(r).toEqual({ kind: 'ok', action: { action: 'build', svg: '<svg/>' } })
  })

  it('maps build_svg with a project title, trimmed and bounded', () => {
    const r = actionFromToolCall(
      call('build_svg', { svg: '<svg/>', name: '  Mountain Sunset  ' })
    )
    expect(r).toEqual({
      kind: 'ok',
      action: { action: 'build', svg: '<svg/>', projectName: 'Mountain Sunset' },
    })

    const long = actionFromToolCall(call('build_svg', { svg: '<svg/>', name: 'x'.repeat(200) }))
    expect(long.kind).toBe('ok')
    if (long.kind === 'ok' && long.action.action === 'build') {
      expect(long.action.projectName).toHaveLength(80)
    }
  })

  it('drops an unusable project title instead of rejecting the build', () => {
    for (const name of [undefined, '', '   ', 42, { title: 'no' }]) {
      const r = actionFromToolCall(call('build_svg', { svg: '<svg/>', name }))
      expect(r).toEqual({ kind: 'ok', action: { action: 'build', svg: '<svg/>' } })
    }
  })

  it('maps apply_edits to an edit action with the operations payload', () => {
    const r = actionFromToolCall(
      call('apply_edits', { operations: [{ type: 'setAttributes', target: 'el-1', attributes: {} }] })
    )
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'edit') {
      expect(r.action.operations).toEqual({
        operations: [{ type: 'setAttributes', target: 'el-1', attributes: {} }],
      })
    }
  })

  it('maps ask_question and defaults questionId', () => {
    const r = actionFromToolCall(
      call('ask_question', {
        prompt: 'Which palette?',
        choices: [
          { id: 'a', label: 'Warm' },
          { id: 'b', label: 'Cool' },
        ],
      })
    )
    expect(r).toEqual({
      kind: 'ok',
      action: {
        action: 'question',
        questionId: 'q',
        prompt: 'Which palette?',
        choices: [
          { id: 'a', label: 'Warm' },
          { id: 'b', label: 'Cool' },
        ],
      },
    })
  })

  it('rejects ask_question with unusable choices', () => {
    const r = actionFromToolCall(call('ask_question', { prompt: 'P?', choices: [{ id: 'a', label: 'A' }] }))
    expect(r.kind).toBe('invalid')
  })

  it('maps propose_plan with validated attribute controls', () => {
    const r = actionFromToolCall(
      call('propose_plan', {
        steps: [{ id: 's1', label: 'Sky' }],
        attributes: [
          { id: 'mood', label: 'Mood', type: 'text', defaultValue: 'calm' },
          { label: 'no id', type: 'text', defaultValue: 'x' },
        ],
      })
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.action.action).toBe('plan')
    expect(r.attributeControls?.map((c) => c.id)).toEqual(['mood'])
  })

  it('synthesizes step ids when the model omits them', () => {
    const r = actionFromToolCall(
      call('propose_plan', {
        steps: [{ label: 'Sky' }, { label: 'Mountains' }, { id: '  ', label: 'Sun' }],
      })
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    if (r.action.action !== 'plan') return
    expect(r.action.steps.map((s) => s.id)).toEqual(['step-1', 'step-2', 'step-3'])
  })

  it('uniquifies duplicated step ids and trims labels', () => {
    const r = actionFromToolCall(
      call('propose_plan', {
        steps: [
          { id: 's1', label: ' Sky ' },
          { id: 's1', label: 'Mountains' },
          { id: 's1-2', label: 'Sun' },
        ],
      })
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    if (r.action.action !== 'plan') return
    expect(r.action.steps.map((s) => s.id)).toEqual(['s1', 's1-2', 's1-2-2'])
    expect(r.action.steps[0].label).toBe('Sky')
  })

  it('rejects bad inputs with a concrete reason', () => {
    expect(actionFromToolCall(call('build_svg', {})).kind).toBe('invalid')
    expect(actionFromToolCall(call('apply_edits', { operations: 'x' })).kind).toBe('invalid')
    expect(actionFromToolCall(call('propose_plan', {})).kind).toBe('invalid')
    expect(actionFromToolCall(call('explode', {})).kind).toBe('invalid')
  })
})

describe('toolResultOutput', () => {
  it('wraps the retry feedback payload in a typed json tool result', () => {
    // The AI SDK ModelMessage schema requires tool-result outputs to be
    // type-discriminated; a bare payload object fails validation.
    expect(toolResultOutput({ ok: false, errors: ['target el-9 not found'] })).toEqual({
      type: 'json',
      value: { ok: false, errors: ['target el-9 not found'] },
    })
    expect(
      toolResultOutput({ ok: true, applied: true, visualReviewIssues: ['title clipped'] })
    ).toEqual({
      type: 'json',
      value: { ok: true, applied: true, visualReviewIssues: ['title clipped'] },
    })
  })
})
