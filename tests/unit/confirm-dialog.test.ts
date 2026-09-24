// @vitest-environment jsdom
/**
 * The in-app confirm that replaced window.confirm: one promise per request,
 * one dialog at a time, Escape and Cancel both answer false.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { confirm, ConfirmHost } from '../../src/renderer/components/ui/confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(createElement(ConfirmHost)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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
