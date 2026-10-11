// @vitest-environment jsdom
/**
 * Add agent, Sign-in step with env rows: a bad row shows its error inline and
 * keeps Continue off, so the account is never saved without the keys typed in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { AddAgentDialog } = await import('../../src/renderer/components/settings/AddAgentDialog')
const { useProviderInstanceStore } = await import('../../src/renderer/stores/provider-instance-store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const upsert = vi.fn(async (input: object) => ({ id: 'new', ...input }))

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click()
  })
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const keyInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!
const valueInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Value"]')!
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent)

beforeEach(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  ;(window as unknown as { api: unknown }).api = {
    provider: { isAvailable: vi.fn(async () => true) },
    providerInstances: { testDraft: vi.fn(async () => ({ ok: true, message: 'ok' })) },
  }
  useProviderInstanceStore.setState({ upsert } as never)
  upsert.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(AddAgentDialog, {
        instances: [],
        storedModel: () => '',
        onClose: () => {},
        onAdded: () => {},
      }),
    )
  })
  await click(document.querySelector<HTMLElement>('[aria-label="OpenCode"]')!)
  await click(button('Continue'))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('Add agent env rows', () => {
  it('blocks Continue on a bad name and shows why at the row', async () => {
    await type(keyInput(), '1BAD')
    await type(valueInput(), 'x')
    expect(button('Continue').disabled).toBe(true)
    expect(keyInput().getAttribute('aria-invalid')).toBe('true')
    expect(alerts()).toContain('"1BAD" is not a variable name. Use letters, digits and _, not a digit first.')
  })

  it('blocks Continue on a value with no name', async () => {
    await type(valueInput(), 'orphan')
    expect(button('Continue').disabled).toBe(true)
    expect(alerts()).toContain('Enter a name for this value.')
  })

  it('saves the keys once the rows are valid', async () => {
    await type(keyInput(), 'OPENROUTER_API_KEY')
    await type(valueInput(), 'sk-1')
    expect(alerts()).toEqual([])
    await click(button('Continue'))
    const save = button('Add agent')
    expect(save.disabled).toBe(false)
    await click(save)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ env: { OPENROUTER_API_KEY: 'sk-1' } }))
  })
})
