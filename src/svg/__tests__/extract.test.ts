import { describe, expect, it } from 'vitest'
import {
  extractFencedBlock,
  extractSvg,
  hasOpenFence,
  inspectFencedBlock,
  inspectJson,
} from '../extract'

describe('extractFencedBlock tolerance', () => {
  it('extracts a normal fenced block', () => {
    const text = 'here you go\n```svg\n<svg/>\n```\ndone'
    expect(extractFencedBlock(text, 'svg')).toBe('<svg/>')
  })

  it('recovers an unterminated fence (truncated output)', () => {
    const text = 'drawing...\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect'
    expect(extractFencedBlock(text, 'svg')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect'
    )
  })

  it('is case-insensitive on the language tag', () => {
    expect(extractFencedBlock('```SVG\n<svg/>\n```', 'svg')).toBe('<svg/>')
  })
})

describe('inspectFencedBlock', () => {
  it('reports absent when no block with the language exists', () => {
    expect(inspectFencedBlock('plain text only', 'snaplot-edits')).toEqual({ kind: 'absent' })
  })

  it('reports malformed for unterminated and empty blocks', () => {
    expect(inspectFencedBlock('```snaplot-edits\n{"operations":[', 'snaplot-edits').kind).toBe('malformed')
    expect(inspectFencedBlock('```snaplot-edits\n\n```', 'snaplot-edits').kind).toBe('malformed')
  })
})

describe('extractSvg fallbacks', () => {
  const doc = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

  it('reads svg from a ```svg fence first', () => {
    expect(extractSvg(`a\n\`\`\`svg\n${doc}\n\`\`\``)).toBe(doc)
  })

  it('falls back to xml/html alias fences containing an svg', () => {
    expect(extractSvg(`\`\`\`xml\n${doc}\n\`\`\``)).toBe(doc)
    expect(extractSvg(`\`\`\`html\n<div>${doc}</div>\n\`\`\``)).toBe(doc)
  })

  it('falls back to a bare svg document without any fence', () => {
    expect(extractSvg(`Sure! Here is the artwork:\n${doc}`)).toBe(doc)
  })

  it('returns null when there is no svg at all', () => {
    expect(extractSvg('just talking, no artwork')).toBeNull()
  })
})

describe('inspectJson', () => {
  it('returns the parsed value for valid JSON', () => {
    const { status, value } = inspectJson<{ a: number }>(
      '```snaplot-edits\n{"a":1}\n```',
      'snaplot-edits'
    )
    expect(status.kind).toBe('ok')
    expect(value).toEqual({ a: 1 })
  })

  it('reports malformed with the parse error for invalid JSON', () => {
    const { status, value } = inspectJson('```snaplot-edits\n{"a":1,}\n```', 'snaplot-edits')
    expect(status.kind).toBe('malformed')
    expect(status.kind === 'malformed' && status.reason).toContain('invalid JSON')
    expect(value).toBeNull()
  })
})

describe('hasOpenFence', () => {
  it('is true while a payload fence is still open', () => {
    expect(hasOpenFence('Working.\n```snaplot-action\n{"action":"ed')).toBe(true)
    expect(hasOpenFence('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rec')).toBe(true)
  })

  it('is true for a bare opening marker with no newline yet', () => {
    expect(hasOpenFence('Drawing\n```svg')).toBe(true)
  })

  it('is false once every fence is closed or absent', () => {
    expect(hasOpenFence('```svg\n<svg/>\n```\nDone')).toBe(false)
    expect(hasOpenFence('plain prose only')).toBe(false)
  })
})
