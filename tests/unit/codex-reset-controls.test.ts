// @vitest-environment jsdom
/**
 * The Codex card's reset controls: when "Use reset" shows, the inline
 * confirm, the locked state while it runs, and the result states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CodexResetControls } from '../../src/renderer/components/settings/CodexResetControls'
import type { CodexResetOutcome } from '../../src/shared/codex-reset'
import { buildWindow, type ProviderUsage, type UsageResetCredits } from '../../src/shared/provider-usage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const DAY = 86_400_000
const CREDITS: UsageResetCredits = {
  availableCount: 2,
  credits: [
    { id: 'late', expiresAtMs: NOW + 34 * DAY, status: 'available', title: 'Weekly limit reset' },
    { id: 'soon', expiresAtMs: NOW + 19 * DAY, status: 'available', title: 'Weekly limit reset' },
  ],
}

function usage(session: number, resetCredits: UsageResetCredits | null = CREDITS): ProviderUsage {
  return {
    instanceId: 'codex-a',
    agentType: 'codex',
    status: 'ok',
    plan: null,
    account: null,
    windows: [
      buildWindow({
        id: 's',
        label: '5-hour',
        kind: 'session',
        percent: session,
        resetsAtMs: NOW + 3 * 3_600_000,
        windowMinutes: 300,
      }),
      buildWindow({
        id: 'w',
        label: 'Weekly',
        kind: 'weekly',
        percent: 40,
        resetsAtMs: NOW + 3 * DAY,
        windowMinutes: 10080,
      }),
    ],
    overage: [],
    ...(resetCredits ? { resetCredits } : {}),
    fetchedAtMs: NOW,
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(u: ProviderUsage | undefined, onConsume: (creditId: string | null) => Promise<CodexResetOutcome>) {
  act(() => root.render(createElement(CodexResetControls, { usage: u, onConsume })))
}

const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name) ?? null
const text = () => container.textContent ?? ''

describe('CodexResetControls', () => {
  it('shows the count without a button while there is room', () => {
    render(usage(34), vi.fn())
    expect(text()).toContain('Resets available: 2')
    expect(text()).toContain('next expires')
    expect(buttonNamed('Use reset')).toBeNull()
  })

  it('shows nothing when Codex reports no resets', () => {
    render(usage(100, null), vi.fn())
    expect(container.innerHTML).toBe('')
    render(usage(100, { availableCount: 0, credits: null }), vi.fn())
    expect(container.innerHTML).toBe('')
  })

  it('offers Use reset at a critical window and confirms inline before spending', async () => {
    const onConsume = vi.fn(async () => 'reset' as const)
    render(usage(100), onConsume)
    act(() => buttonNamed('Use reset')!.click())

    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Use a reset?')
    expect(dialog?.textContent).toContain('Codex usage limits')
    expect(dialog?.textContent).toContain('Remaining1')
    expect(dialog?.textContent).toContain('This cannot be undone.')
    expect(onConsume).not.toHaveBeenCalled()

    act(() => buttonNamed('Cancel')!.click())
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onConsume).not.toHaveBeenCalled()

    act(() => buttonNamed('Use reset')!.click())
    await act(async () => buttonNamed('Use reset')!.click())
    expect(onConsume).toHaveBeenCalledWith('soon')
  })

  it('locks the button while applying, then shows the result', async () => {
    let finish!: (outcome: CodexResetOutcome) => void
    const onConsume = vi.fn(
      () =>
        new Promise<CodexResetOutcome>((resolve) => {
          finish = resolve
        }),
    )
    render(usage(100), onConsume)
    act(() => buttonNamed('Use reset')!.click())
    await act(async () => buttonNamed('Use reset')!.click())
    const locked = buttonNamed('Applying reset…')
    expect(locked?.disabled).toBe(true)

    await act(async () => finish('reset'))
    // The store already swapped in the reading taken after the spend.
    render(usage(0, { availableCount: 1, credits: null }), onConsume)
    expect(text()).toContain('Limits reset. 1 reset remaining.')
    expect(buttonNamed('Use reset')).toBeNull()
    act(() => (container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
    expect(text()).not.toContain('Limits reset.')
  })

  it('offers Try again after an unknown outcome', async () => {
    const onConsume = vi.fn(async (): Promise<CodexResetOutcome> => 'unknown')
    render(usage(100), onConsume)
    act(() => buttonNamed('Use reset')!.click())
    await act(async () => buttonNamed('Use reset')!.click())
    expect(text()).toContain('Codex did not respond, so the result is unknown. Retrying will not use a second reset.')
    expect(container.querySelector('button[aria-label="Dismiss"]')).toBeNull()
    await act(async () => buttonNamed('Try again')!.click())
    expect(onConsume).toHaveBeenCalledTimes(2)
  })

  it('hides the button after nothingToReset until a window is at its limit', async () => {
    const onConsume = vi.fn(async (): Promise<CodexResetOutcome> => 'nothingToReset')
    render(usage(88), onConsume)
    act(() => buttonNamed('Use reset')!.click())
    await act(async () => buttonNamed('Use reset')!.click())
    expect(text()).toContain('No limit is eligible for a reset yet. Nothing was used.')
    expect(buttonNamed('Use reset')).toBeNull()
    render(usage(100), onConsume)
    expect(buttonNamed('Use reset')).not.toBeNull()
  })
})
