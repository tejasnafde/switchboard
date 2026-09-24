// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { focusReturnTarget } from '../../src/renderer/components/ui/focus-return'

afterEach(() => { document.body.innerHTML = '' })

function composer(): HTMLElement {
  const panel = document.createElement('div')
  panel.setAttribute('data-chat-panel', '')
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  panel.append(editor)
  document.body.append(panel)
  return editor
}

describe('focusReturnTarget', () => {
  it('returns the saved element while it is still in the document', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    composer()
    expect(focusReturnTarget(opener)).toBe(opener)
  })

  it('falls back to the composer when the saved element is gone, <body> or missing', () => {
    const editor = composer()
    expect(focusReturnTarget(document.createElement('button'))).toBe(editor)
    expect(focusReturnTarget(document.body)).toBe(editor)
    expect(focusReturnTarget(null)).toBe(editor)
  })

  it('returns null with no composer to fall back to', () => {
    expect(focusReturnTarget(null)).toBeNull()
  })
})
