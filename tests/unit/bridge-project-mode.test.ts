// @vitest-environment jsdom
/**
 * Settings > Labs, the Highest mode of one bridge project: the picker shows
 * the stored cap, a narrower cap saves straight away, Full access asks first
 * and saves only on Yes, and a saved Full access carries its risk note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BridgeProjectSetupRow } from '../../src/shared/bridge'
import { BridgeProjectsPanel } from '../../src/renderer/components/settings/BridgeProjectsPanel'
import { BRIDGE_MODE_OPTIONS, bridgeModeConfirm } from '../../src/renderer/components/settings/bridge-setup-model'
import { ConfirmHost } from '../../src/renderer/components/ui/confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const listProjects = vi.fn()
const setProjectMode = vi.fn()

const PROJECT: BridgeProjectSetupRow = {
  path: '/repo/lexsi',
  name: 'lexsi',
  allowed: true,
  projectId: 'bproj_1',
  orphan: false,
  maximumMode: 'auto',
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  listProjects.mockReset().mockResolvedValue({ enabled: true, projects: [PROJECT] })
  setProjectMode.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    bridge: { listProjects, setProjectMode, setProjectAllowed: vi.fn(), removeProject: vi.fn() },
  }
  window.HTMLElement.prototype.scrollIntoView = () => {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(BridgeProjectsPanel), createElement(ConfirmHost)))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="Highest mode for lexsi"]')!
const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]

async function pick(label: string) {
  await act(async () => trigger().click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const row = rows().find((r) => r.textContent === label)!
  await act(async () => row.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

async function answer(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
  await act(async () => button.click())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

describe('the Highest mode picker', () => {
  it('offers every mode narrowest first and shows the stored cap', async () => {
    await mount()
    expect(BRIDGE_MODE_OPTIONS.map((o) => o.label)).toEqual([
      'Plan',
      'Supervised',
      'Auto-accept edits',
      'Auto',
      'Full access',
    ])
    expect(trigger().textContent).toContain('Auto')
  })

  it('saves a narrower cap with no question', async () => {
    setProjectMode.mockResolvedValue({ enabled: true, projects: [{ ...PROJECT, maximumMode: 'plan' }] })
    await mount()
    await pick('Plan')
    expect(setProjectMode).toHaveBeenCalledWith('bproj_1', 'plan')
  })

  it('asks before Full access and saves nothing when the owner says no', async () => {
    await mount()
    await pick('Full access')
    expect(document.body.textContent).toContain('Let the bridge use Full access in lexsi?')
    expect(document.body.textContent).toContain('no prompt')
    await answer('Cancel')
    expect(setProjectMode).not.toHaveBeenCalled()
  })

  it('saves Full access on Yes and then shows the risk note on the row', async () => {
    setProjectMode.mockResolvedValue({ enabled: true, projects: [{ ...PROJECT, maximumMode: 'full-access' }] })
    await mount()
    await pick('Full access')
    await answer('Use Full access')
    expect(setProjectMode).toHaveBeenCalledWith('bproj_1', 'full-access')
    const panel = container.querySelector('[data-testid="bridge-projects"]')!
    expect(panel.textContent).toContain('Full access lets the bridge drive chats here')
  })

  it('shows no picker for a project that is not allowed or whose folder moved', async () => {
    listProjects.mockResolvedValue({
      enabled: true,
      projects: [
        { ...PROJECT, allowed: false, maximumMode: null },
        { ...PROJECT, name: 'gone', projectId: 'bproj_2', orphan: true },
      ],
    })
    await mount()
    expect(document.querySelector('[aria-label="Highest mode for lexsi"]')).toBeNull()
    expect(document.querySelector('[aria-label="Highest mode for gone"]')).toBeNull()
  })

  it('asks only for the cap that needs a question', () => {
    expect(bridgeModeConfirm('lexsi', 'auto')).toBeNull()
    expect(bridgeModeConfirm('lexsi', 'full-access')).toMatchObject({
      confirmLabel: 'Use Full access',
      destructive: true,
    })
  })
})
