/**
 * The pure size helpers behind `read_chat`'s budget: a preview keeps the head
 * and the tail of a long text with a marker between them, a window reads on
 * from an offset in order, and neither ever goes over the bytes it was given.
 */
import { describe, expect, it } from 'vitest'
import { cutMarker, jsonBytes, previewText, windowText } from '../../src/main/bridge/read-budget'

const REPORT = Array.from({ length: 4000 }, (_, i) => `line ${i}: what the agent found, in plain words`).join('\n')

describe('previewText', () => {
  it('keeps a short text whole and says nothing was cut', () => {
    expect(previewText('done with the header', 1024)).toEqual({
      text: 'done with the header',
      offset: 0,
      truncated: false,
      nextOffset: null,
    })
  })

  it('keeps the head and the tail of a long text, names the cut and fits the bytes', () => {
    const chunk = previewText(REPORT, 4096)
    expect(REPORT.length).toBeGreaterThan(150_000)
    expect(chunk.truncated).toBe(true)
    expect(jsonBytes(chunk.text)).toBeLessThanOrEqual(4096)
    expect(chunk.text.startsWith('line 0:')).toBe(true)
    expect(chunk.text.endsWith('line 3999: what the agent found, in plain words')).toBe(true)
    const marker = /\n\[\.\.\. (\d+) characters cut \.\.\.\]\n/.exec(chunk.text)
    expect(marker).not.toBeNull()
    // Read on from the end of the head.
    expect(chunk.nextOffset).toBe(marker!.index)
    const head = chunk.text.slice(0, marker!.index)
    const tail = chunk.text.slice(marker!.index + marker![0].length)
    expect(REPORT.startsWith(head)).toBe(true)
    expect(REPORT.endsWith(tail)).toBe(true)
    expect(head.length + tail.length + Number(marker![1])).toBe(REPORT.length)
    expect(cutMarker(7)).toBe('\n[... 7 characters cut ...]\n')
  })

  it('never splits an astral character in half', () => {
    const text = '🙂'.repeat(4000)
    const chunk = previewText(text, 512)
    expect(chunk.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(chunk.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(jsonBytes(chunk.text)).toBeLessThanOrEqual(512)
  })
})

describe('windowText', () => {
  it('reads the whole text in order, page by page, and stops', () => {
    let offset: number | null = 0
    let read = ''
    let pages = 0
    while (offset !== null) {
      const page: ReturnType<typeof windowText> = windowText(REPORT, offset, 8192)
      expect(jsonBytes(page.text)).toBeLessThanOrEqual(8192)
      expect(page.offset).toBe(offset)
      read += page.text
      offset = page.nextOffset
      pages += 1
      expect(pages).toBeLessThan(200)
    }
    expect(read).toBe(REPORT)
    expect(pages).toBeGreaterThan(5)
  })

  it('answers an offset past the end with nothing left to read', () => {
    expect(windowText('short', 99, 1024)).toEqual({ text: '', offset: 5, truncated: false, nextOffset: null })
  })
})
