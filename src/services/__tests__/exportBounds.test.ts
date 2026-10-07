import { describe, expect, it } from 'vitest'
import { exportPngDocument, clampOutputSize, MAX_PNG_WIDTH, MAX_PNG_PIXELS, type Rasterizer } from '../export'

const PNG_BLOB = new Blob(['png'], { type: 'image/png' })

function tallSvg(ratio: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 ${ratio}"><rect x="0" y="0" width="1" height="${ratio}"/></svg>`
}

describe('PNG output dimensions are bounded on both axes (audit A5)', () => {
  it('clamps an extreme tall aspect instead of allocating a giant canvas', async () => {
    let captured: { w: number; h: number } | null = null
    const rasterize: Rasterizer = async (_svg, w, h) => {
      captured = { w, h }
      return PNG_BLOB
    }
    const result = await exportPngDocument(tallSvg(1_000_000), { width: 1024, scale: 1, background: null }, { rasterize })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.height).toBeLessThanOrEqual(MAX_PNG_WIDTH)
      expect(result.width).toBeLessThanOrEqual(MAX_PNG_WIDTH)
      expect(result.width * result.height).toBeLessThanOrEqual(MAX_PNG_PIXELS)
      expect(captured!.w).toBe(result.width)
      expect(captured!.h).toBe(result.height)
    }
  })

  it('clamps an extreme wide aspect symmetrically', async () => {
    const wide = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 1"><rect x="0" y="0" width="1000000" height="1"/></svg>`
    const result = await exportPngDocument(wide, { width: 1024, scale: 1, background: null }, {
      rasterize: async () => PNG_BLOB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.height).toBeLessThanOrEqual(MAX_PNG_WIDTH)
      expect(result.width).toBeLessThanOrEqual(MAX_PNG_WIDTH)
      expect(result.width * result.height).toBeLessThanOrEqual(MAX_PNG_PIXELS)
    }
  })

  it('keeps ordinary aspect ratios untouched', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect x="0" y="0" width="640" height="480"/></svg>`
    const result = await exportPngDocument(svg, { width: 640, scale: 1, background: null }, {
      rasterize: async () => PNG_BLOB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.width).toBe(640)
      expect(result.height).toBe(480)
    }
  })

  it('scales a max-size square down to the total pixel cap, preserving aspect', async () => {
    const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30000 30000"><rect x="0" y="0" width="30000" height="30000"/></svg>`
    const result = await exportPngDocument(square, { width: 8192, scale: 4, background: null }, {
      rasterize: async () => PNG_BLOB,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.width).toBe(result.height)
      expect(result.width * result.height).toBeLessThanOrEqual(MAX_PNG_PIXELS)
      expect(result.width).toBeGreaterThan(7000)
    }
  })

  it('clampOutputSize preserves aspect within the caps', () => {
    const tall = clampOutputSize(1024, 1.024e9)
    expect(tall.height).toBe(MAX_PNG_WIDTH)
    expect(tall.width).toBe(1)

    const square = clampOutputSize(8192, 8192)
    expect(square.width * square.height).toBeLessThanOrEqual(MAX_PNG_PIXELS)
    expect(square.width).toBe(square.height)

    const normal = clampOutputSize(640, 480)
    expect(normal).toEqual({ width: 640, height: 480 })
  })
})
