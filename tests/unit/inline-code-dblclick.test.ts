// @vitest-environment jsdom
/**
 * A double-click on inline code in chat markdown selects the whole span
 * (word selection stops at `-`, `.` and `/`). Fenced code blocks, plain words
 * and single clicks keep the selection the browser made.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownWithCopyControls } from '../../src/renderer/components/chat/MarkdownWithCopyControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(MarkdownWithCopyControls, {
        markdown: 'Run `npm run migration-gate` before plain-word.\n\n```sh\nnpm run migration-gate\n```\n',
      }),
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.getSelection()?.removeAllRanges()
})

// What the browser's word selection leaves after a double-click on `gate`.
function selectWordGate(text: Text): void {
  const start = text.data.indexOf('gate')
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, start + 'gate'.length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

function fire(target: Element, type: 'dblclick' | 'click'): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, detail: type === 'dblclick' ? 2 : 1 }))
  })
}

const inlineCode = (): HTMLElement => container.querySelector('p > code')!
const blockCode = (): HTMLElement => container.querySelector('pre code')!

describe('double-click on inline code', () => {
  it('selects the whole inline code span', () => {
    selectWordGate(inlineCode().firstChild as Text)
    fire(inlineCode(), 'dblclick')
    expect(window.getSelection()!.toString()).toBe('npm run migration-gate')
  })

  it('keeps word selection in a fenced code block', () => {
    selectWordGate(blockCode().firstChild as Text)
    fire(blockCode(), 'dblclick')
    expect(window.getSelection()!.toString()).toBe('gate')
  })

  it('keeps word selection on plain text', () => {
    const paragraph = container.querySelector('p')!
    const text = paragraph.lastChild as Text
    const range = document.createRange()
    range.setStart(text, text.data.indexOf('plain'))
    range.setEnd(text, text.data.indexOf('plain') + 'plain'.length)
    window.getSelection()!.addRange(range)
    fire(paragraph, 'dblclick')
    expect(window.getSelection()!.toString()).toBe('plain')
  })

  it('leaves a single click alone', () => {
    selectWordGate(inlineCode().firstChild as Text)
    fire(inlineCode(), 'click')
    expect(window.getSelection()!.toString()).toBe('gate')
  })
})
