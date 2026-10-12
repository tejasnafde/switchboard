// @vitest-environment jsdom
/**
 * The chip's hover card offers to open the source the way the chip was
 * reached: "Click to open" for the pointer, the Enter hint for a chip selected
 * with the keyboard, nothing when it cannot be opened, and the notice instead
 * when the last open found the source gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PillChipCard, type PillOpenHint } from '../../src/renderer/components/chat/lexical/PillChipVisual'
import { pillChipModel } from '../../src/renderer/services/pill-chip-model'
import { MESSAGE_GONE_NOTICE } from '../../src/renderer/services/pill-chip-open'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const model = pillChipModel({ kind: 'chat-message', label: 'Claude: "The exchange"' })

function renderCard(openHint: PillOpenHint, notice: string | null = null): void {
  act(() => root.render(createElement(PillChipCard, { model, removable: false, openHint, notice })))
}

const hint = (): HTMLElement | null => container.querySelector('[data-pill-open-hint]')

describe('chip card open hint', () => {
  it('says "Click to open" when the pointer opened the card', () => {
    renderCard('pointer')
    expect(hint()?.textContent).toBe('Click to open')
    expect(container.textContent).not.toContain('↵')
  })

  it('shows the Enter hint only for a keyboard-selected chip', () => {
    renderCard('keyboard')
    expect(hint()?.getAttribute('data-pill-open-hint')).toBe('keyboard')
    expect(hint()?.textContent).toBe('↵ open')
    expect(container.textContent).not.toContain('Click to open')
  })

  it('shows no open hint for a chip it cannot open', () => {
    renderCard(null)
    expect(hint()).toBeNull()
  })

  it('says the message is gone instead of offering to open it', () => {
    renderCard('pointer', MESSAGE_GONE_NOTICE)
    expect(container.querySelector('[data-pill-notice]')?.textContent).toBe('Message no longer in this chat')
    expect(hint()).toBeNull()
  })
})
