// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onEscapeFirst } from '../../src/renderer/components/ui/escape-first'

const press = (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  return event
}

describe('onEscapeFirst', () => {
  // Stands in for a Radix dialog, which listens for Escape on the document.
  const dialogEscape = vi.fn()
  const onDocument = (event: KeyboardEvent) => { if (event.key === 'Escape') dialogEscape() }
  document.addEventListener('keydown', onDocument, true)
  afterEach(() => dialogEscape.mockClear())

  it('answers Escape before a document listener sees it', () => {
    const handler = vi.fn()
    const off = onEscapeFirst(handler)
    const event = press('Escape')
    off()
    expect(handler).toHaveBeenCalledOnce()
    expect(dialogEscape).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves other keys alone', () => {
    const handler = vi.fn()
    const off = onEscapeFirst(handler)
    const event = press('Enter')
    off()
    expect(handler).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('stops answering after cleanup, so the dialog gets Escape again', () => {
    const handler = vi.fn()
    onEscapeFirst(handler)()
    press('Escape')
    expect(handler).not.toHaveBeenCalled()
    expect(dialogEscape).toHaveBeenCalledOnce()
  })
})
