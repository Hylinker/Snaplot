import { describe, expect, it } from 'vitest'
import { parseReply, parseActionEnvelope, parseLegacyAction } from '../actionEnvelope'
import { verifyEdits, verifySvgBuild } from '../../svg/verify'

const CURRENT = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1" width="10" height="10"/></svg>'

describe('parseReply (action envelope)', () => {
  it('parses a plan envelope', () => {
    const r = parseReply(
      'Here is the plan.\n```snaplot-action\n{"action":"plan","steps":[{"id":"s1","label":"Draw background"}]}\n```'
    )
    expect(r).toEqual({
      kind: 'ok',
      action: { action: 'plan', steps: [{ id: 's1', label: 'Draw background' }] },
    })
  })

  it('parses a build envelope with inline SVG string', () => {
    const r = parseReply('```snaplot-action\n{"action":"build","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\"/>"}\n```')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'build') {
      expect(r.action.svg).toContain('<svg')
    }
  })

  it('parses a build envelope with a companion svg fence', () => {
    const r = parseReply(
      'Drawing now.\n```snaplot-action\n{"action":"build"}\n```\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```'
    )
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'build') {
      expect(r.action.svg).toContain('<svg')
    }
  })

  it('parses an edit envelope', () => {
    const r = parseReply(
      '```snaplot-action\n{"action":"edit","operations":[{"type":"setAttributes","target":"el-1","attributes":{"fill":"#00f"}}]}\n```'
    )
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'edit') {
      expect(Array.isArray((r.action.operations as { operations: unknown[] }).operations)).toBe(true)
    }
  })

  it('parses a question envelope', () => {
    const r = parseReply(
      '```snaplot-action\n{"action":"question","questionId":"style","prompt":"Which style?","choices":[{"id":"a","label":"Flat"}]}\n```'
    )
    expect(r).toEqual({
      kind: 'ok',
      action: {
        action: 'question',
        questionId: 'style',
        prompt: 'Which style?',
        choices: [{ id: 'a', label: 'Flat' }],
      },
    })
  })

  it('reports malformed envelope JSON', () => {
    const r = parseActionEnvelope('```snaplot-action\n{"action":"build",}\n```')
    expect(r.kind).toBe('malformed')
  })

  it('falls back to legacy fenced blocks', () => {
    const edits = parseLegacyAction(
      '```snaplot-edits\n{"operations":[{"type":"removeElement","target":"el-1","reason":"x"}]}\n```'
    )
    expect(edits.kind).toBe('ok')
    const svg = parseLegacyAction('```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```')
    expect(svg.kind).toBe('ok')
    const absent = parseLegacyAction('just text')
    expect(absent.kind).toBe('absent')
  })

  it('treats plain text as absent', () => {
    expect(parseReply('hello there').kind).toBe('absent')
  })

  it('ignores a bare json fence (not an envelope)', () => {
    const r = parseActionEnvelope(
      'Example payload:\n```json\n{"action":"build","svg":"<svg/>"}\n```'
    )
    expect(r.kind).toBe('absent')
  })

  it('rescues a bare json fence containing a valid action', () => {
    const r = parseReply('Example payload:\n```json\n{"action":"build","svg":"<svg/>"}\n```')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'build') {
      expect(r.action.svg).toContain('<svg')
    }
  })

  it('rescues the companion build form inside a bare json fence', () => {
    const r = parseReply(
      '```json\n{"action":"build"}\n```\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```'
    )
    expect(r.kind).toBe('ok')
  })

  it('still treats an unparsable or action-less json fence as absent', () => {
    expect(parseReply('```json\n{"build": true,}\n```').kind).toBe('absent')
    expect(parseReply('```json\n{"answer": 42}\n```').kind).toBe('absent')
  })

  it('recovers a build from a malformed envelope plus a valid svg fence', () => {
    const r = parseReply(
      '```snaplot-action\n{"action":"build","svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\">}\n```\n' +
        '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n```'
    )
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok' && r.action.action === 'build') {
      expect(r.action.svg).toContain('<rect')
    }
  })

  it('reports malformed when the envelope is broken and nothing recovers', () => {
    const r = parseReply('```snaplot-action\n{"action":"build",}\n```')
    expect(r.kind).toBe('malformed')
  })
})

describe('verifySvgBuild', () => {
  it('accepts a valid document and canonicalizes it', () => {
    const r = verifySvgBuild('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>')
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('<rect')
  })

  it('rejects documents without drawable elements', () => {
    const r = verifySvgBuild('<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>')
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('no drawable elements')
  })

  it('strips unsafe attributes from the result', () => {
    const r = verifySvgBuild(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="5" height="5"/></svg>'
    )
    expect(r.ok).toBe(true)
    expect(r.svg).not.toContain('onload')
  })
})

describe('verifyEdits', () => {
  it('applies valid operations and canonicalizes the result', () => {
    const r = verifyEdits(CURRENT, {
      operations: [{ type: 'setAttributes', target: 'el-1', reason: 'x', attributes: { fill: '#00f' } }],
    })
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('#00f')
  })

  it('returns deterministic errors for unknown targets', () => {
    const r = verifyEdits(CURRENT, {
      operations: [{ type: 'removeElement', target: 'el-9', reason: 'x' }],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('el-9')
  })

  it('fails without artwork', () => {
    const r = verifyEdits(null, { operations: [] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('no artwork')
  })

})
