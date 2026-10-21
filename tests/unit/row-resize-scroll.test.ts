import { describe, expect, it } from 'vitest'
import { keepViewOnRowResize } from '../../src/renderer/services/row-resize-scroll'

/** A scroll box that clamps like a browser: the scroll never passes content height minus view height. */
function scrollBox(contentHeight: number, clientHeight: number, scrollTop: number) {
  const content = { style: { height: `${contentHeight}px` } }
  let top = scrollTop
  const container = {
    get scrollTop() {
      return top
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, parseFloat(content.style.height) - clientHeight))
    },
  }
  return { container, content }
}

describe('keepViewOnRowResize', () => {
  it('leaves the scroll alone for a row that starts in or below the view', () => {
    const { container, content } = scrollBox(2000, 600, 500)
    expect(keepViewOnRowResize(container, content, 500, 40)).toBe(false)
    expect(container.scrollTop).toBe(500)
    expect(content.style.height).toBe('2000px')
  })

  it('moves the scroll by a shrink of a row above the view', () => {
    const { container, content } = scrollBox(2000, 600, 1400)
    expect(keepViewOnRowResize(container, content, 900, -25)).toBe(true)
    expect(container.scrollTop).toBe(1375)
  })

  // A live frame at the top edge of a chat scrolled to the bottom: its growth
  // was clamped away, the rows under it moved down, and the frame came back
  // into view (the jitter loop).
  it('moves the scroll by a growth of a row above the view at the bottom of the list', () => {
    const { container, content } = scrollBox(2000, 600, 1400)
    expect(keepViewOnRowResize(container, content, 900, 25)).toBe(true)
    expect(container.scrollTop).toBe(1425)
    expect(content.style.height).toBe('2025px')
  })

  it('makes a shrink and a growth of the same size cancel out at the bottom', () => {
    const { container, content } = scrollBox(2000, 600, 1400)
    keepViewOnRowResize(container, content, 900, -25)
    content.style.height = '1975px'
    keepViewOnRowResize(container, content, 900, 25)
    expect(container.scrollTop).toBe(1400)
  })
})
