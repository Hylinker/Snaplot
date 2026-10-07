import { describe, it, expect } from 'vitest'
import {
  exportSvgDocument,
  exportPngDocument,
  copyPngToClipboard,
  buildFileName,
  clampPngWidth,
  clampPngScale,
  intrinsicDimensions,
  type Rasterizer,
} from '../export'

const DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100" height="100" fill="red"/></svg>`
const EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"></svg>`
const PNG_BLOB = new Blob(['png'], { type: 'image/png' })

describe('R4 exportSvgDocument', () => {
  it('sanitizes and canonicalizes the current document', () => {
    const result = exportSvgDocument(DRAWING)
    if (!result.ok) throw new Error(result.error)
    expect(result.svg).toContain('<rect')
    expect(result.svg).toContain('fill="red"')
    expect(result.svg.startsWith('<svg')).toBe(true)
  })

  it('strips unsafe content from the exported file', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>alert(1)</script>' +
      '<rect width="5" height="5" onclick="alert(1)" fill="blue"/> ' +
      '<image href="https://evil.example/x.png" width="1" height="1"/>' +
      '</svg>'
    const result = exportSvgDocument(dirty)
    if (!result.ok) throw new Error(result.error)
    expect(result.svg).not.toContain('script')
    expect(result.svg).not.toContain('onclick')
    expect(result.svg).not.toContain('evil.example')
  })

  it('rejects an empty document', () => {
    const result = exportSvgDocument(EMPTY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no drawable elements')
  })

  it('rejects unparseable input', () => {
    const result = exportSvgDocument('not xml')
    expect(result.ok).toBe(false)
  })
})

describe('R4 exportPngDocument', () => {
  it('computes output size from width, scale, and aspect ratio', async () => {
    let seen: { svg: string; w: number; h: number; bg: string | null } | null = null
    const rasterize: Rasterizer = async (svg, w, h, bg) => {
      seen = { svg, w, h, bg }
      return PNG_BLOB
    }
    const result = await exportPngDocument(
      DRAWING,
      { width: 320, scale: 2, background: '#ffffff' },
      { rasterize }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blob).toBe(PNG_BLOB)
    // 640x480 aspect (3:2): width 320*2=640 -> height 480
    expect(result.width).toBe(640)
    expect(result.height).toBe(480)
    expect(seen!.w).toBe(640)
    expect(seen!.h).toBe(480)
    expect(seen!.bg).toBe('#ffffff')
    // The rasterized document carries explicit pixel dimensions.
    expect(seen!.svg).toContain('width="640"')
    expect(seen!.svg).toContain('height="480"')
    // The source document has no viewBox: resizing without one crops instead
    // of scaling, so a matching viewBox must be injected.
    expect(seen!.svg).toContain('viewBox="0 0 640 480"')
  })

  it('keeps an existing viewBox untouched', async () => {
    let seenSvg = ''
    const rasterize: Rasterizer = async (svg) => {
      seenSvg = svg
      return PNG_BLOB
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 400 200"><rect width="10" height="10"/></svg>'
    await exportPngDocument(svg, { width: 200, scale: 2, background: null }, { rasterize })
    expect(seenSvg).toContain('viewBox="0 0 400 200"')
    expect(seenSvg).toContain('width="400"')
    expect(seenSvg).toContain('height="200"')
  })

  it('falls back to the viewBox when width/height are not pixel lengths', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 50"><circle cx="5" cy="5" r="4"/></svg>'
    const result = await exportPngDocument(
      svg,
      { width: 200, scale: 1, background: null },
      { rasterize: async () => PNG_BLOB }
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.height).toBe(100)
  })

  it('derives the aspect ratio from the viewBox when width/height are absent', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><circle cx="5" cy="5" r="4"/></svg>'
    const result = await exportPngDocument(
      svg,
      { width: 200, scale: 1, background: null },
      { rasterize: async () => PNG_BLOB }
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.width).toBe(200)
    expect(result.height).toBe(100)
  })

  it('passes background through to the rasterizer', async () => {
    let bg: string | null = 'sentinel'
    const rasterize: Rasterizer = async (_svg, _w, _h, background) => {
      bg = background
      return PNG_BLOB
    }
    await exportPngDocument(DRAWING, { width: 100, scale: 1, background: null }, { rasterize })
    expect(bg).toBeNull()
  })

  it('clamps width and scale to the allowed ranges', async () => {
    const fake: Rasterizer = async () => PNG_BLOB
    const result = await exportPngDocument(
      DRAWING,
      { width: 99999, scale: 99, background: null },
      { rasterize: fake }
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.width).toBe(8192)
    const tiny = await exportPngDocument(
      DRAWING,
      { width: 1, scale: 0.01, background: null },
      { rasterize: fake }
    )
    if (!tiny.ok) throw new Error(tiny.error)
    expect(tiny.width).toBe(4) // 16 * 0.25
  })

  it('maps rasterizer failure to a readable error', async () => {
    const rasterize: Rasterizer = async () => {
      throw new Error('boom')
    }
    const result = await exportPngDocument(DRAWING, { width: 100, scale: 1, background: null }, { rasterize })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('boom')
  })

  it('times out when rasterization never resolves', async () => {
    const rasterize: Rasterizer = () => new Promise<Blob>(() => {})
    const result = await exportPngDocument(
      DRAWING,
      { width: 100, scale: 1, background: null, timeoutMs: 20 },
      { rasterize }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('timed out')
  })

  it('rejects an empty document before rasterizing', async () => {
    let called = false
    const rasterize: Rasterizer = async () => {
      called = true
      return PNG_BLOB
    }
    const result = await exportPngDocument(EMPTY, { width: 100, scale: 1, background: null }, { rasterize })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no drawable elements')
    expect(called).toBe(false)
  })
})

describe('R4 copyPngToClipboard', () => {
  type FakeItem = { blob: Promise<Blob> }

  const fakeItem = (blob: Promise<Blob>): ClipboardItem =>
    ({ blob }) as unknown as ClipboardItem

  it('writes the rasterized blob to the clipboard', async () => {
    const made: FakeItem[] = []
    const written: ClipboardItem[][] = []
    const result = await copyPngToClipboard(
      DRAWING,
      { width: 320, scale: 1, background: null },
      {
        rasterize: async () => PNG_BLOB,
        makeItem: (blob) => {
          const item = { blob }
          made.push(item)
          return item as unknown as ClipboardItem
        },
        write: async (items) => {
          written.push(items)
        },
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.blob).toBe(PNG_BLOB)
    expect(result.width).toBe(320)
    expect(made.length).toBe(1)
    await expect(made[0].blob).resolves.toBe(PNG_BLOB)
    expect(written).toEqual([[made[0]]])
  })

  it('initiates the clipboard write before rasterization finishes', async () => {
    let resolveRaster: (blob: Blob) => void = () => {}
    let writeCalled = false
    const resultPromise = copyPngToClipboard(
      DRAWING,
      { width: 100, scale: 1, background: null },
      {
        rasterize: () => new Promise<Blob>((resolve) => { resolveRaster = resolve }),
        makeItem: fakeItem,
        write: async () => { writeCalled = true },
      }
    )
    // clipboard.write must run inside the user-activation window, so it has
    // to be in flight while the blob is still being produced.
    expect(writeCalled).toBe(true)
    resolveRaster(PNG_BLOB)
    const result = await resultPromise
    expect(result.ok).toBe(true)
  })

  it('rejects an empty document without touching the clipboard', async () => {
    let writeCalled = false
    const result = await copyPngToClipboard(
      EMPTY,
      { width: 100, scale: 1, background: null },
      {
        rasterize: async () => PNG_BLOB,
        makeItem: fakeItem,
        write: async () => { writeCalled = true },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no drawable elements')
    expect(writeCalled).toBe(false)
  })

  it('surfaces the pipeline error when rasterization fails', async () => {
    const result = await copyPngToClipboard(
      DRAWING,
      { width: 100, scale: 1, background: null },
      {
        rasterize: async () => {
          throw new Error('boom')
        },
        makeItem: fakeItem,
        // Mirrors the browser: the write only settles once the blob resolves.
        write: async (items) => {
          await Promise.all(items.map((item) => (item as unknown as FakeItem).blob))
        },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('boom')
      expect(result.error).not.toContain('Clipboard write failed')
    }
  })

  it('reports a clipboard failure when the write is denied', async () => {
    const result = await copyPngToClipboard(
      DRAWING,
      { width: 100, scale: 1, background: null },
      {
        rasterize: async () => PNG_BLOB,
        makeItem: fakeItem,
        write: async () => {
          throw new Error('denied')
        },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Clipboard write failed')
      expect(result.error).toContain('denied')
    }
  })
})

describe('R4 helpers', () => {
  it('clamps width and scale', () => {
    expect(clampPngWidth(0)).toBe(16)
    expect(clampPngWidth(100000)).toBe(8192)
    expect(clampPngWidth(NaN)).toBe(640)
    expect(clampPngScale(0)).toBe(0.25)
    expect(clampPngScale(10)).toBe(4)
  })

  it('reports intrinsic dimensions from width/height, then viewBox', () => {
    expect(intrinsicDimensions(DRAWING)).toEqual({ width: 640, height: 480 })
    const viewBoxOnly =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><circle cx="5" cy="5" r="4"/></svg>'
    expect(intrinsicDimensions(viewBoxOnly)).toEqual({ width: 100, height: 50 })
    expect(intrinsicDimensions('not xml')).toBeNull()
  })

  it('builds timestamped file names', () => {
    const name = buildFileName('png', { now: new Date(2026, 7, 25, 14, 25, 30) })
    expect(name).toBe('snaplot-20260825-142530.png')
  })

  it('prefixes file names with the sanitized project name', () => {
    const now = new Date(2026, 7, 25, 14, 25, 30)
    expect(buildFileName('svg', { name: 'Sunset poster', now })).toBe('Sunset-poster-20260825-142530.svg')
    expect(buildFileName('png', { name: 'a/b\\c:d*e?f"g<h>i|j', now })).toBe('abcdefghij-20260825-142530.png')
    expect(buildFileName('svg', { name: '   ', now })).toBe('snaplot-20260825-142530.svg')
  })
})
