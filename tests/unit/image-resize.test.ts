import { describe, it, expect } from 'vitest'
import {
  JPEG_STEPS,
  MESSAGE_IMAGE_WIRE_BUDGET,
  PNG_KEEP_WIRE_BYTES,
  dataUrlWireBytes,
  fitWithin,
  imageRefusalMessage,
  resizeAttempts,
  sendAsIs,
  shrinkToBudget,
  type ResizeAttempt,
} from '../../src/shared/image-resize'

describe('fitWithin', () => {
  it('caps the long side and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536, scaled: true })
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048, scaled: true })
  })

  it('never upscales', () => {
    expect(fitWithin(1000, 800, 2048)).toEqual({ width: 1000, height: 800, scaled: false })
  })

  it('keeps a very thin image at least one pixel wide', () => {
    expect(fitWithin(100000, 10, 2048).height).toBe(1)
  })
})

describe('resizeAttempts', () => {
  it('steps a photo down in size, then in quality', () => {
    expect(resizeAttempts('image/jpeg')).toEqual([
      { maxSide: 2048, quality: 0.85, format: 'jpeg' },
      { maxSide: 1600, quality: 0.85, format: 'jpeg' },
      { maxSide: 1280, quality: 0.75, format: 'jpeg' },
    ])
    expect(resizeAttempts('image/webp')).toBe(JPEG_STEPS)
  })

  it('tries a PNG as PNG first, then as a photo', () => {
    expect(resizeAttempts('image/png')).toEqual([{ maxSide: 2048, quality: 1, format: 'png' }, ...JPEG_STEPS])
  })

  it('never re-encodes a GIF, which would drop its animation', () => {
    expect(resizeAttempts('image/gif')).toBeNull()
  })
})

describe('dataUrlWireBytes', () => {
  it('matches the length of the data URL it describes', () => {
    const url = `data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}`
    expect(dataUrlWireBytes('image/jpeg', 5)).toBe(url.length)
  })
})

describe('shrinkToBudget', () => {
  /** Encoder whose output size is looked up by step, recording what was tried. */
  function encoder(sizes: Record<string, number>) {
    const tried: string[] = []
    const encode = async (a: ResizeAttempt) => {
      const key = `${a.format}@${a.maxSide}`
      tried.push(key)
      return { result: key, wireBytes: sizes[key] }
    }
    return { tried, encode }
  }

  it('keeps the first attempt that fits', async () => {
    const { tried, encode } = encoder({ 'jpeg@2048': 900_000 })
    const out = await shrinkToBudget(resizeAttempts('image/jpeg')!, MESSAGE_IMAGE_WIRE_BUDGET, encode)
    expect(out).toMatchObject({ ok: true, result: 'jpeg@2048' })
    expect(tried).toEqual(['jpeg@2048'])
  })

  it('steps down until the image fits', async () => {
    const { tried, encode } = encoder({ 'jpeg@2048': 4e6, 'jpeg@1600': 3.5e6, 'jpeg@1280': 2e6 })
    const out = await shrinkToBudget(JPEG_STEPS, MESSAGE_IMAGE_WIRE_BUDGET, encode)
    expect(out).toMatchObject({ ok: true, result: 'jpeg@1280', attempt: { quality: 0.75 } })
    expect(tried).toEqual(['jpeg@2048', 'jpeg@1600', 'jpeg@1280'])
  })

  it('keeps a small PNG (a screenshot) as PNG', async () => {
    const { encode } = encoder({ 'png@2048': PNG_KEEP_WIRE_BYTES })
    expect(await shrinkToBudget(resizeAttempts('image/png')!, MESSAGE_IMAGE_WIRE_BUDGET, encode)).toMatchObject({
      ok: true,
      result: 'png@2048',
    })
  })

  it('turns a large PNG into a JPEG even when the PNG would fit the budget', async () => {
    const { encode } = encoder({ 'png@2048': PNG_KEEP_WIRE_BYTES + 1, 'jpeg@2048': 500_000 })
    expect(await shrinkToBudget(resizeAttempts('image/png')!, MESSAGE_IMAGE_WIRE_BUDGET, encode)).toMatchObject({
      ok: true,
      result: 'jpeg@2048',
    })
  })

  it('fits what is left of the message, and says so when only that is the problem', async () => {
    const { encode } = encoder({ 'jpeg@2048': 2e6, 'jpeg@1600': 1.5e6, 'jpeg@1280': 1e6 })
    expect(await shrinkToBudget(JPEG_STEPS, 1.2e6, encode)).toMatchObject({ ok: true, result: 'jpeg@1280' })
    expect(await shrinkToBudget(JPEG_STEPS, 500_000, encode)).toEqual({ ok: false, reason: 'over-message-budget' })
  })

  it('refuses an image too large even alone', async () => {
    const { encode } = encoder({ 'jpeg@2048': 9e6, 'jpeg@1600': 8e6, 'jpeg@1280': 4e6 })
    expect(await shrinkToBudget(JPEG_STEPS, MESSAGE_IMAGE_WIRE_BUDGET, encode)).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })
})

describe('sendAsIs', () => {
  it('sends a GIF that fits, and tells a full message from an oversized GIF', () => {
    expect(sendAsIs(1000, 2000)).toBe('ok')
    expect(sendAsIs(1000, 500)).toBe('over-message-budget')
    expect(sendAsIs(MESSAGE_IMAGE_WIRE_BUDGET + 1, MESSAGE_IMAGE_WIRE_BUDGET)).toBe('gif-too-large')
  })
})

describe('imageRefusalMessage', () => {
  it('names the image and the reason', () => {
    expect(imageRefusalMessage('IMG_1.jpg', 'too-large')).toBe(
      'IMG_1.jpg is still over 3 MB after shrinking it to 1280 px',
    )
    expect(imageRefusalMessage('a.png', 'over-message-budget')).toContain('a.png did not fit')
    expect(imageRefusalMessage('cat.gif', 'gif-too-large')).toContain('animation')
  })
})
