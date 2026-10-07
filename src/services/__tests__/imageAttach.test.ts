import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_FILE_BYTES,
  PASS_THROUGH_MAX_BYTES,
  normalizeImageFile,
  type ImageReencoder,
} from '../imageAttach'

/** Only `type` and `size` are read before decoding; plain objects suffice. */
const fakeFile = (type: string, size: number) => ({ type, size }) as unknown as File

describe('normalizeImageFile', () => {
  let reencode: ReturnType<typeof vi.fn>

  beforeEach(() => {
    reencode = vi.fn<ImageReencoder>(async () => 'data:image/jpeg;base64,RE')
  })

  it('passes small supported files through as data URLs', async () => {
    const file = new Blob(['png'], { type: 'image/png' }) as unknown as File
    const result = await normalizeImageFile(file)
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/png;base64,cG5n' })
  })

  it('rejects unsupported formats before reading the file', async () => {
    const result = await normalizeImageFile(fakeFile('text/plain', 10))
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Unsupported image format') })
  })

  it('rejects files above the hard size limit', async () => {
    const result = await normalizeImageFile(fakeFile('image/png', MAX_FILE_BYTES + 1))
    expect(result).toEqual({ ok: false, error: expect.stringContaining('too large') })
  })

  it('re-encodes files above the pass-through size', async () => {
    const file = fakeFile('image/jpeg', PASS_THROUGH_MAX_BYTES + 1)
    const result = await normalizeImageFile(file, { reencode })
    expect(result).toEqual({ ok: true, dataUrl: 'data:image/jpeg;base64,RE' })
    expect(reencode).toHaveBeenCalledOnce()
    expect(reencode).toHaveBeenCalledWith(file)
  })

  it('fails when re-encoding fails', async () => {
    const failing = vi.fn<ImageReencoder>(async () => null)
    const result = await normalizeImageFile(fakeFile('image/jpeg', PASS_THROUGH_MAX_BYTES + 1), {
      reencode: failing,
    })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('could not be processed') })
  })
})
