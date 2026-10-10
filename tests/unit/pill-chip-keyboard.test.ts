// @vitest-environment jsdom
/**
 * The composer chip with the keyboard and the pointer: the arrow keys select
 * a chip, Backspace removes the selected chip, the arrows leave it, and the
 * remove control takes it out. Every removal tells the host to drop the
 * pill's metadata (`sb-pill-remove`) and leaves the body without its token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $getRoot, $isTextNode, type LexicalEditor } from 'lexical'

vi.mock('../../src/renderer/services/pill-chip-open', () => ({ openPillTarget: vi.fn(() => true) }))

import { RichChatTextarea, type RichChatTextareaHandle } from '../../src/renderer/components/chat/lexical/RichChatTextarea'
import { $isPillNode } from '../../src/renderer/components/chat/lexical/PillNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
// jsdom has no layout: Lexical measures the caret to scroll it into view once the editor has focus.
const emptyRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect
Range.prototype.getBoundingClientRect ??= emptyRect
;(Text.prototype as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect ??= emptyRect

const pill = { id: 'p1', label: 'api (12 lines)', kind: 'terminal' as const, content: '[from: api @ 14:31]\nready' }

let root: Root
let container: HTMLDivElement
let value: string
let removed: string[]
const onRemoveEvent = (e: Event) => removed.push((e as CustomEvent<{ id: string }>).detail.id)

function editorOf(): LexicalEditor {
  const el = container.querySelector('[contenteditable="true"]') as HTMLElement & { __lexicalEditor?: LexicalEditor }
  if (!el.__lexicalEditor) throw new Error('no editor')
  return el.__lexicalEditor
}

const chip = () => container.querySelector<HTMLElement>('[data-pill-chip][data-pill-id="p1"]')

async function press(key: string): Promise<void> {
  const el = container.querySelector('[contenteditable="true"]') as HTMLElement
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Put the caret just after the chip, at the start of the text that follows it. */
async function caretAfterChip(): Promise<void> {
  await act(async () => {
    editorOf().update(() => {
      const node = $getRoot().getFirstChild()?.getChildren().find((n) => $isPillNode(n))
      node?.selectNext(0, 0)
    }, { discrete: true })
  })
}

beforeEach(async () => {
  value = 'see [[pill:p1]] now'
  removed = []
  window.addEventListener('sb-pill-remove', onRemoveEvent)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const ref = createRef<RichChatTextareaHandle>()
  await act(async () => root.render(createElement(RichChatTextarea, {
    ref,
    value,
    onChange: (next: string) => { value = next },
    pillsById: { p1: pill },
  })))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener('sb-pill-remove', onRemoveEvent)
})

describe('composer context chip', () => {
  it('draws the chip with its name, count and remove control', () => {
    expect(chip()).not.toBeNull()
    expect(chip()!.textContent).toContain('api')
    expect(chip()!.textContent).toContain('12 lines')
    expect(chip()!.querySelector('[aria-label="Remove terminal api"]')).not.toBeNull()
  })

  it('selects the chip with the left arrow and removes it with Backspace', async () => {
    await caretAfterChip()
    await press('ArrowLeft')
    expect(chip()!.getAttribute('data-selected')).toBe('true')
    await press('Backspace')
    expect(chip()).toBeNull()
    expect(removed).toEqual(['p1'])
    expect(value).not.toContain('[[pill:p1]]')
    expect(value).toContain('see')
  })

  it('leaves the selected chip with the right arrow, keeping it', async () => {
    await caretAfterChip()
    await press('ArrowLeft')
    expect(chip()!.getAttribute('data-selected')).toBe('true')
    await press('ArrowRight')
    expect(chip()!.getAttribute('data-selected')).toBeNull()
    await press('Backspace')
    // The caret is after the chip again, so Backspace no longer targets it as a selection.
    expect(removed).toEqual([])
  })

  it('opens the card with Space on a selected chip, without taking focus', async () => {
    const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
    await act(async () => { editable.focus() })
    await caretAfterChip()
    await press('ArrowLeft')
    await press(' ')
    const card = document.querySelector('[role="tooltip"][aria-label="Terminal: api"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('ready')
    expect(document.activeElement).toBe(editable)
    await press(' ')
    expect(document.querySelector('[role="tooltip"][aria-label="Terminal: api"]')).toBeNull()
  })

  it('types after a selected chip instead of dropping the key', async () => {
    await caretAfterChip()
    await press('ArrowLeft')
    await press('x')
    expect(chip()).not.toBeNull()
    expect(value).toContain('[[pill:p1]]x')
    let text = ''
    editorOf().getEditorState().read(() => {
      text = $getRoot().getAllTextNodes().filter($isTextNode).map((n) => n.getTextContent()).join('|')
    })
    expect(text).toContain('x')
  })

  it('removes the chip with its remove control', async () => {
    const button = chip()!.querySelector<HTMLButtonElement>('[data-pill-remove]')!
    await act(async () => { button.click() })
    expect(chip()).toBeNull()
    expect(removed).toEqual(['p1'])
    expect(value).not.toContain('[[pill:p1]]')
  })
})
