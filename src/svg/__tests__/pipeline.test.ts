import { describe, expect, it } from 'vitest'
import { extractSvg, extractJson, extractFencedBlock, stripFencedBlocks } from '../extract'
import { sanitizeSvg } from '../sanitize'
import { assignStableIds } from '../ids'
import { canonicalizeSvg } from '../canonicalize'
import { applyEditOperations } from '../edits'

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect id="el-1" x="10" y="10" width="30" height="30" fill="#f00"/>
</svg>`

describe('R3 edit result canonicalization', () => {
  it('assigns stable ids to inserted elements after applying edits', () => {
    const result = applyEditOperations(SAMPLE_SVG, {
      operations: [
        {
          type: 'insertElement',
          target: 'el-1',
          reason: 'add caption',
          element: '<text xmlns="http://www.w3.org/2000/svg">Hi</text>',
        },
      ],
    })
    expect(result.ok).toBe(true)
    const { svg } = assignStableIds(result.svg!)
    expect(svg).toMatch(/id="el-2"/)
  })

  it('removing the selected element leaves no dangling id', () => {
    const result = applyEditOperations(SAMPLE_SVG, {
      operations: [{ type: 'removeElement', target: 'el-1', reason: 'cleanup' }],
    })
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('el-1')
  })
})

describe('extract', () => {
  it('extracts a valid svg fenced block', () => {
    const text = 'Here it is.\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```'
    expect(extractSvg(text)).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>')
  })

  it('recovers truncated output from an unterminated fence', () => {
    expect(extractFencedBlock('```svg\n<svg/>', 'svg')).toBe('<svg/>')
  })

  it('returns null when block missing', () => {
    expect(extractSvg('no blocks here')).toBeNull()
  })

  it('parses snaplot-edits JSON', () => {
    const text = 'Edit:\n```snaplot-edits\n{"operations":[]}\n```'
    expect(extractJson(text, 'snaplot-edits')).toEqual({ operations: [] })
  })

  it('returns null on invalid JSON', () => {
    expect(extractJson('```snaplot-edits\n{oops}\n```', 'snaplot-edits')).toBeNull()
  })

  it('strips fenced blocks from display text', () => {
    const out = stripFencedBlocks('Explanation\n```svg\n<svg/>\n```\nDone')
    expect(out).toBe('Explanation\nDone')
  })

  it('strips a still-open action fence so partial payloads never flash in chat', () => {
    const out = stripFencedBlocks(
      'Working on it.\n```snaplot-action\n{"action":"edit","operations":[{"type":"setAttr'
    )
    expect(out).toBe('Working on it.')
  })

  it('strips an unterminated svg fence mid-document', () => {
    const out = stripFencedBlocks(
      'Here is the drawing:\n```svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect x="10"'
    )
    expect(out).toBe('Here is the drawing:')
  })

  it('keeps prose between a closed fence and a still-open fence', () => {
    const out = stripFencedBlocks(
      '```svg\n<svg/>\n```\nNow refining.\n```snaplot-edits\n{"operations":[{"ty'
    )
    expect(out).toBe('Now refining.')
  })

  it('strips a bare opening fence line with no newline yet', () => {
    expect(stripFencedBlocks('Drawing\n```svg')).toBe('Drawing')
  })
})

describe('sanitize', () => {
  it('removes script elements and event handlers', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onclick="alert(1)" x="0" y="0" width="1" height="1"/></svg>`
    const result = sanitizeSvg(dirty)
    expect(result.ok).toBe(true)
    expect(result.removedElements).toContain('script')
    expect(result.removedAttributes).toContain('rect@onclick')
    expect(result.svg).not.toContain('script')
    expect(result.svg).not.toContain('onclick')
  })

  it('rejects javascript: urls', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>`
    const result = sanitizeSvg(dirty)
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('javascript:')
  })

  it('rejects data:text/html', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,payload"><text>x</text></a></svg>`
    expect(sanitizeSvg(dirty).svg).not.toContain('data:text/html')
  })

  it('rejects external http references', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/x.png"/></svg>`
    const result = sanitizeSvg(dirty)
    expect(result.removedAttributes.some((a) => a.includes('href'))).toBe(true)
  })

  it('keeps fragment references', () => {
    const clean = `<svg xmlns="http://www.w3.org/2000/svg"><use href="#shape"/></svg>`
    const result = sanitizeSvg(clean)
    expect(result.svg).toContain('#shape')
  })

  it('keeps common presentation attributes on allowed elements', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <text x="1" textLength="8" lengthAdjust="spacing" paint-order="stroke" alignment-baseline="middle">Hi</text>
      <path d="M0 0L1 1" vector-effect="non-scaling-stroke"/>
      <pattern patternTransform="rotate(30)"><rect width="1" height="1"/></pattern>
      <mask maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="2" height="2"/></mask>
      <filter filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"><feComposite operator="arithmetic" k1="0.2" k2="0.3" k3="0.4" k4="0.5"/></filter>
      <defs><path id="p" d="M0 0"/></defs><text><textPath href="#p" startOffset="10%">x</textPath></text>
    </svg>`
    const result = sanitizeSvg(svg)
    expect(result.ok).toBe(true)
    for (const attr of [
      'textLength="8"',
      'lengthAdjust',
      'paint-order',
      'alignment-baseline',
      'vector-effect',
      'patternTransform',
      'maskUnits',
      'maskContentUnits',
      'filterUnits',
      'primitiveUnits',
      'k1="0.2"',
      'startOffset',
    ]) {
      expect(result.svg).toContain(attr)
    }
  })

  it('rejects invalid XML', () => {
    const result = sanitizeSvg('<svg><unclosed>')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Invalid XML/i)
  })

  it('preserves title/desc and role', () => {
    const clean = `<svg xmlns="http://www.w3.org/2000/svg" role="img"><title>T</title><desc>D</desc></svg>`
    const result = sanitizeSvg(clean)
    expect(result.svg).toContain('<title>T</title>')
    expect(result.svg).toContain('role="img"')
  })
})

describe('assignStableIds', () => {
  it('assigns ids to addressable elements without ids', () => {
    const { svg } = assignStableIds(SAMPLE_SVG.replace('id="el-1" ', ''))
    expect(svg).toMatch(/id="el-\d+"/)
  })

  it('preserves existing safe ids', () => {
    const { svg } = assignStableIds(SAMPLE_SVG)
    expect(svg).toContain('id="el-1"')
  })

  it('resolves duplicate ids', () => {
    const dup = `<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/><circle id="a"/></svg>`
    const { svg, clearedSelectionIds } = assignStableIds(dup)
    expect(clearedSelectionIds).toEqual(['a'])
    // first 'a' preserved, duplicate regenerated in the snaplot namespace
    expect(svg).toContain('id="a"')
    const regenerated = svg.match(/id="el-\d+"/g) ?? []
    expect(regenerated.length).toBe(1)
    const allIds = svg.match(/id="([^"]+)"/g) ?? []
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  it('replaces editor-internal svg_ ids and is idempotent across runs', () => {
    const manual = `<svg xmlns="http://www.w3.org/2000/svg"><rect id="svg_5" width="10" height="10"/></svg>`
    const first = assignStableIds(manual).svg
    expect(first).not.toContain('svg_5')
    expect(first).toMatch(/id="el-\d+"/)
    // Running again on the assigned document must not renumber anything.
    expect(assignStableIds(first).svg).toBe(first)
  })
})

describe('canonicalizeSvg', () => {
  it('is deterministic regardless of attribute order and whitespace', () => {
    const a = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect   fill="#f00"  x="1" /></svg>`
    const b = `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect x="1" fill="#f00"/></svg>`
    expect(canonicalizeSvg(a)).toBe(canonicalizeSvg(b))
  })

  it('drops comments and blank text nodes', () => {
    const out = canonicalizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><!-- c --> <g> </g></svg>`)
    expect(out).not.toContain('<!--')
  })
})

describe('applyEditOperations', () => {
  it('applies setAttributes', () => {
    const payload = { operations: [{ type: 'setAttributes', target: 'el-1', reason: 'darken', attributes: { fill: '#123' } }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(true)
    expect(result.svg).toContain('#123')
  })

  it('applies setRoot in its documented shape (no target)', () => {
    const payload = { operations: [{ type: 'setRoot', reason: 'widen canvas', attributes: { width: '800' } }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(true)
    expect(result.svg).toContain('width="800"')
  })

  it('applies insertElement and removeElement', () => {
    const payload = {
      operations: [
        { type: 'insertElement', target: 'el-1', position: 'after', reason: 'add circle', element: '<circle xmlns="http://www.w3.org/2000/svg" cx="5" cy="5" r="2"/>' },
      ],
    }
    const inserted = applyEditOperations(SAMPLE_SVG, payload)
    expect(inserted.ok).toBe(true)
    const removed = applyEditOperations(inserted.svg!, { operations: [{ type: 'removeElement', target: 'el-1', reason: 'cleanup' }] })
    expect(removed.ok).toBe(true)
    expect(removed.svg).not.toContain('rect')
  })

  it('rejects unknown operation types without partial application', () => {
    const payload = {
      operations: [
        { type: 'setAttributes', target: 'el-1', attributes: { fill: '#123' } },
        { type: 'explodeEverything', target: 'el-1' },
      ],
    }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(false)
    expect(result.svg).toBeNull()
    expect(result.errors[0]).toContain('unknown operation type')
  })

  it('rejects missing target atomically', () => {
    const payload = { operations: [{ type: 'removeElement', target: 'nope', reason: 'x' }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('not found')
  })

  it('rejects insertElement without an element XML string', () => {
    const payload = { operations: [{ type: 'insertElement', target: 'el-1', reason: 'add circle' }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(false)
    expect(result.svg).toBeNull()
    expect(result.errors).toContain('operations[0].element: required XML string')
  })

  it('rejects replaceElement whose element is an object instead of an XML string', () => {
    const payload = {
      operations: [{ type: 'replaceElement', target: 'el-1', reason: 'swap shape', element: { tag: 'circle', r: 5 } }],
    }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('operations[0].element: required XML string')
  })

  it('rejects setFullSvg without an svg string', () => {
    const payload = { operations: [{ type: 'setFullSvg', reason: 'redesign' }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('operations[0].svg: required SVG string')
  })

  it('accepts empty operations as a no-op', () => {
    const result = applyEditOperations(SAMPLE_SVG, { operations: [] })
    expect(result.ok).toBe(true)
    expect(result.appliedCount).toBe(0)
  })

  it('handles setFullSvg with sanitization', () => {
    const payload = { operations: [{ type: 'setFullSvg', reason: 'broad repair', svg: `<svg xmlns="http://www.w3.org/2000/svg"><script/><rect width="1" height="1"/></svg>` }] }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('script')
  })

  it('sanitizes inserted content', () => {
    const payload = {
      operations: [
        { type: 'insertElement', target: 'el-1', reason: 'add', element: '<rect xmlns="http://www.w3.org/2000/svg" onclick="x" width="1" height="1"/>' },
      ],
    }
    const result = applyEditOperations(SAMPLE_SVG, payload)
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('onclick')
  })
})
