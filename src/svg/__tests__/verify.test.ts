import { describe, expect, it } from 'vitest'
import { applyEditOperations } from '../edits'
import { verifyEdits, verifySvgBuild, MAX_BYTES, MAX_ELEMENTS } from '../verify'

const SVG_NS = 'http://www.w3.org/2000/svg'
const CURRENT = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="el-1" width="10" height="10"/></svg>'

/** Re-parse a serialized result and return the first element matching tag. */
function elementOf(svg: string, tag: string): Element | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  return doc.querySelector(tag)
}

describe('edit fragments stay in the SVG namespace (audit A3)', () => {
  it('inserts the documented xmlns-less fragment as a real SVG element', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        {
          type: 'insertElement',
          target: 'el-1',
          position: 'after',
          reason: 'add circle',
          element: '<circle cx="5" cy="5" r="4"/>',
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('xmlns=""')
    expect(elementOf(result.svg!, 'circle')?.namespaceURI).toBe(SVG_NS)
  })

  it('replaces with an xmlns-less fragment in the SVG namespace', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        { type: 'replaceElement', target: 'el-1', reason: 'swap shape', element: '<circle cx="5" cy="5" r="4"/>' },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.svg).not.toContain('xmlns=""')
    expect(elementOf(result.svg!, 'circle')?.namespaceURI).toBe(SVG_NS)
  })

  it('still accepts fragments that declare the SVG namespace explicitly', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        {
          type: 'insertElement',
          target: 'el-1',
          reason: 'add circle',
          element: '<circle xmlns="http://www.w3.org/2000/svg" cx="5" cy="5" r="4"/>',
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(elementOf(result.svg!, 'circle')?.namespaceURI).toBe(SVG_NS)
  })

  it('rejects a fragment with multiple root elements', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        { type: 'insertElement', target: 'el-1', reason: 'x', element: '<rect width="1" height="1"/><circle r="1"/>' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('exactly one element')
  })

  it('rejects a fragment without any element', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [{ type: 'insertElement', target: 'el-1', reason: 'x', element: 'just text' }],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('exactly one element')
  })

  it('rejects foreign-namespace fragments', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        {
          type: 'insertElement',
          target: 'el-1',
          reason: 'x',
          element: '<div xmlns="http://www.w3.org/1999/xhtml">hi</div>',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('SVG element')
  })

  it('rejects fragments containing foreign-namespace descendants', () => {
    const result = applyEditOperations(CURRENT, {
      operations: [
        {
          type: 'insertElement',
          target: 'el-1',
          reason: 'x',
          element: '<g><span xmlns="http://www.w3.org/1999/xhtml">hi</span></g>',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('SVG element')
  })
})

describe('edit results obey the document budgets (audit A4)', () => {
  it('rejects a setFullSvg that exceeds the byte budget', () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(MAX_BYTES + 1000)}</text></svg>`
    const r = verifyEdits(CURRENT, { operations: [{ type: 'setFullSvg', reason: 'x', svg: huge }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('byte budget')
  })

  it('counts the byte budget in UTF-8 bytes, not UTF-16 code units (edits)', () => {
    // 70,000 CJK chars are 70,000 UTF-16 code units but 210,000 UTF-8 bytes.
    const text = '好'.repeat(70_000)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`
    expect(svg.length).toBeLessThan(MAX_BYTES)
    const r = verifyEdits(CURRENT, { operations: [{ type: 'setFullSvg', reason: 'x', svg }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('byte budget')
  })

  it('counts the byte budget in UTF-8 bytes (builds)', () => {
    const text = '好'.repeat(70_000)
    const r = verifySvgBuild(`<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('byte budget')
  })

  it('rejects a setFullSvg above the element budget', () => {
    const rects = '<rect width="1" height="1"/>'.repeat(MAX_ELEMENTS + 1)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${rects}</svg>`
    const r = verifyEdits(CURRENT, { operations: [{ type: 'setFullSvg', reason: 'x', svg }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('element budget')
  })

  it('rejects repeated insertions that grow past the element budget', () => {
    const operations = Array.from({ length: MAX_ELEMENTS }, () => ({
      type: 'insertElement' as const,
      target: 'el-1',
      reason: 'fill',
      element: '<rect width="1" height="1"/>',
    }))
    const r = verifyEdits(CURRENT, { operations })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('element budget')
  })

  it('rejects an edit result with no drawable elements', () => {
    const r = verifyEdits(CURRENT, {
      operations: [{ type: 'setFullSvg', reason: 'x', svg: '<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>' }],
    })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('no drawable elements')
  })

  it('rejects oversized raw setFullSvg input before parsing', () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(2_000_000)}</text></svg>`
    const r = verifyEdits(CURRENT, { operations: [{ type: 'setFullSvg', reason: 'x', svg: huge }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('too large')
  })

  it('still accepts a small setFullSvg and ordinary edits', () => {
    const replaced = verifyEdits(CURRENT, {
      operations: [
        { type: 'setFullSvg', reason: 'redesign', svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' },
      ],
    })
    expect(replaced.ok).toBe(true)

    const tweaked = verifyEdits(CURRENT, {
      operations: [{ type: 'setAttributes', target: 'el-1', reason: 'x', attributes: { fill: '#0a7' } }],
    })
    expect(tweaked.ok).toBe(true)
  })
})
