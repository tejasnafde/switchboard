// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PromptModal } from '../../src/renderer/components/sidebar/PromptModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('PromptModal', () => {
  it('opens with focus in the input and its text selected', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(PromptModal, { title: 'Rename chat', initialValue: 'Old title', onSubmit: vi.fn(), onCancel: vi.fn() }))
    })
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
    expect(input).not.toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(input))
    expect([input!.selectionStart, input!.selectionEnd]).toEqual([0, 'Old title'.length])
  })
})
