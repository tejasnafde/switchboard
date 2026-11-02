// @vitest-environment jsdom
/**
 * Settings > Devices shows the reconnect switch while hub_remote_children is
 * on, and reads the flag again when settings.json changes with the page open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const { HubMachinesSection } = await import('../../src/renderer/components/SettingsPage')
const { SETTINGS_CHANGED_ELSEWHERE } = await import('../../src/renderer/services/settings-file-sync')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let flag = false
const shown = () => container.querySelector('[data-setting-row="hub.reconnectOnLaunch"]') !== null

beforeEach(async () => {
  flag = false
  ;(window as unknown as { api: unknown }).api = { machines: { hubRemoteEnabled: vi.fn(async () => flag) } }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(HubMachinesSection))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('HubMachinesSection', () => {
  it('shows the switch once the flag turns on in settings.json, with no remount', async () => {
    expect(shown()).toBe(false)
    flag = true
    await act(async () => {
      window.dispatchEvent(new Event(SETTINGS_CHANGED_ELSEWHERE))
    })
    expect(shown()).toBe(true)
  })
})
