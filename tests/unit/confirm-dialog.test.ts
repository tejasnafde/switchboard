// @vitest-environment jsdom
/**
 * The in-app confirm that replaced window.confirm: one promise per request,
 * one dialog at a time, Escape and Cancel both answer false.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { confirm, ConfirmHost, unlessConfirmOpen } from '../../src/renderer/components/ui/confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(ConfirmHost)))
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  // Radix hands focus back from a setTimeout after the dialog unmounts. Let it
  // run here, or on a loaded machine it fires inside the next test and
  // consumes the focus target that test just recorded.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

const dialog = () => document.querySelector('[role="alertdialog"]')
const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === name)
  if (!found) throw new Error(`no button named ${name}`)
  return found
}

// Wrapped, because an async function returning the promise would wait for it.
async function ask(options: Parameters<typeof confirm>[0]): Promise<{ answer: Promise<boolean> }> {
  let answer!: Promise<boolean>
  await act(async () => { answer = confirm(options) })
  return { answer }
}

describe('confirm', () => {
  it('resolves true when the action is clicked, and closes', async () => {
    const { answer } = await ask({ title: 'Delete workspace "A"?', body: 'Its projects will move to Ungrouped.', confirmLabel: 'Delete', destructive: true })
    expect(dialog()?.textContent).toContain('Delete workspace "A"?')
    expect(dialog()?.textContent).toContain('Its projects will move to Ungrouped.')
    await act(async () => button('Delete').click())
    await expect(answer).resolves.toBe(true)
    expect(dialog()).toBeNull()
  })

  it('returns focus to the element that was focused before it opened', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Remove project'
    document.body.append(opener)
    opener.focus()
    const { answer } = await ask({ title: 'Remove "api"?' })
    expect(document.activeElement).not.toBe(opener)
    await act(async () => button('Cancel').click())
    await answer
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('falls back to the composer when the opener was removed', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const panel = document.createElement('div')
    panel.setAttribute('data-chat-panel', '')
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    panel.append(editor)
    document.body.append(panel)
    const { answer } = await ask({ title: 'Remove "api"?' })
    opener.remove()
    await act(async () => button('Cancel').click())
    await answer
    await vi.waitFor(() => expect(document.activeElement).toBe(editor))
    panel.remove()
  })

  it('resolves false on Cancel', async () => {
    const { answer } = await ask({ title: 'Remove machine "box"?' })
    await act(async () => button('Cancel').click())
    await expect(answer).resolves.toBe(false)
    expect(dialog()).toBeNull()
  })

  it('resolves false on Escape', async () => {
    const { answer } = await ask({ title: 'Remove machine "box"?' })
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await expect(answer).resolves.toBe(false)
    expect(dialog()).toBeNull()
  })

  it('keeps Escape from the modal that opened it', async () => {
    // Registered after confirm's own listener, like a Settings or
    // WorkspaceManager modal opened later, in both phases those modals use.
    const hostSaw: string[] = []
    const onCapture = () => hostSaw.push('window capture')
    const onBubble = () => hostSaw.push('window bubble')
    window.addEventListener('keydown', onCapture, true)
    window.addEventListener('keydown', onBubble)
    try {
      const { answer } = await ask({ title: 'Delete launch config "dev"?' })
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await expect(answer).resolves.toBe(false)
      expect(hostSaw).toEqual([])

      // With no dialog open, Escape belongs to the host again.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(hostSaw).toEqual(['window capture', 'window bubble'])
    } finally {
      window.removeEventListener('keydown', onCapture, true)
      window.removeEventListener('keydown', onBubble)
    }
  })

  it('holds app shortcuts back while open', async () => {
    const appSaw: string[] = []
    const onShortcut = (event: KeyboardEvent) => appSaw.push(event.key)
    window.addEventListener('keydown', onShortcut, true)
    try {
      const { answer } = await ask({ title: 'Replace the current draft with the failed message?' })
      // ⌘2 switches chats and ⌘L appends to a draft; either would change what the answer acts on.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }))
      expect(appSaw).toEqual([])
      await act(async () => button('Cancel').click())
      await expect(answer).resolves.toBe(false)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', metaKey: true }))
      expect(appSaw).toEqual(['2'])
    } finally {
      window.removeEventListener('keydown', onShortcut, true)
    }
  })

  it('holds native menu actions back while open', async () => {
    // Menu accelerators arrive over IPC, so the key guard never sees them.
    const ran: Array<{ shift?: boolean }> = []
    const onClosePaneOrWindow = unlessConfirmOpen((opts: { shift?: boolean }) => ran.push(opts))
    const { answer } = await ask({ title: 'Delete launch config "dev"?' })
    onClosePaneOrWindow({ shift: true })
    expect(ran).toEqual([])
    await act(async () => button('Cancel').click())
    await expect(answer).resolves.toBe(false)

    onClosePaneOrWindow({ shift: true })
    expect(ran).toEqual([{ shift: true }])
  })

  it('does not let a held Escape cancel the confirm queued behind', async () => {
    const { answer: first } = await ask({ title: 'First?' })
    const { answer: second } = await ask({ title: 'Second?' })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await expect(first).resolves.toBe(false)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }))
    })
    expect(dialog()?.textContent).toContain('Second?')
    await act(async () => button('Cancel').click())
    await expect(second).resolves.toBe(false)
  })

  it('shows one dialog at a time and answers each request on its own', async () => {
    const { answer: first } = await ask({ title: 'First?', confirmLabel: 'Yes' })
    const { answer: second } = await ask({ title: 'Second?', confirmLabel: 'Yes' })
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1)
    expect(dialog()?.textContent).toContain('First?')

    // Confirming the first must not also cancel the one queued behind it.
    await act(async () => button('Yes').click())
    await expect(first).resolves.toBe(true)
    expect(dialog()?.textContent).toContain('Second?')

    await act(async () => button('Cancel').click())
    await expect(second).resolves.toBe(false)
    expect(dialog()).toBeNull()
  })
})
