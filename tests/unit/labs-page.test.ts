// @vitest-environment jsdom
/**
 * Settings > Labs through the real value bindings: a switch saves its
 * `labs.<flag>` row and shows it again after a reload, a failed write returns
 * to the stored value, an env-forced flag is on and disabled with its stored
 * row off, a dependent flag is off and disabled while its parent is off, and
 * the read-only rows have no switch. Search finds a row by key, env var and
 * warning text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LabsFlagState } from '../../src/shared/labs'
import { LabsPage } from '../../src/renderer/components/settings/LabsPage'
import { useSettingValues } from '../../src/renderer/components/settings/setting-values'
import { searchSettingRows } from '../../src/renderer/components/settings/settings-rows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let rows: Map<string, string>
let forced: string[]
let failWrites: boolean
const bridgeProjects = vi.fn()
const setProjectAllowed = vi.fn()
const set = vi.fn(async (key: string, value: string) => {
  if (failWrites) throw new Error('refused')
  rows.set(key, value)
})

// Every other binding reads through some window.api call; they answer null.
const anything: unknown = new Proxy(() => Promise.resolve(null), {
  get: (_t, prop) => (prop === 'then' ? undefined : anything),
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  rows = new Map()
  forced = []
  failWrites = false
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      settings: {
        get: async (key: string) => rows.get(key) ?? null,
        set,
        labsState: async (): Promise<Partial<LabsFlagState>[]> => forced.map((id) => ({ id, forced: true, on: true })),
      },
      bridge: { listProjects: bridgeProjects, setProjectAllowed },
    },
    { get: (target, prop) => (prop in target ? target[prop as 'settings'] : anything) },
  )
  window.HTMLElement.prototype.scrollIntoView = () => {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function Harness() {
  const { values, set: setValue } = useSettingValues()
  return createElement(LabsPage, { values, set: setValue, highlight: null })
}

async function mount() {
  await act(async () => root.render(createElement(Harness)))
  await act(async () => {})
}

async function unmountAndMount() {
  act(() => root.unmount())
  root = createRoot(container)
  await mount()
}

function row(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-setting-row="${id}"]`)!
}
function toggle(id: string): HTMLButtonElement | null {
  return row(id).querySelector<HTMLButtonElement>('[role="switch"]')
}

describe('Labs page', () => {
  it('shows the Instinct bridge projects only while the flag is on, and saves a checkbox', async () => {
    const project = { path: '/repo', name: 'repo', projectId: 'bproj_1' }
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [{ ...project, allowed: false }] })
    setProjectAllowed.mockResolvedValue({ enabled: true, projects: [{ ...project, allowed: true }] })
    await mount()
    expect(container.querySelector('[data-testid="bridge-projects"]')).toBeNull()
    expect(bridgeProjects).not.toHaveBeenCalled()

    await act(async () => toggle('labs.instinct_bridge')!.click())
    await act(async () => {})
    const box = container.querySelector<HTMLButtonElement>('[data-testid="bridge-projects"] [role="checkbox"]')!
    expect(box.getAttribute('aria-checked')).toBe('false')
    await act(async () => box.click())
    expect(setProjectAllowed).toHaveBeenCalledWith('/repo', true)
    expect(box.getAttribute('aria-checked')).toBe('true')
  })

  it('renders every flag off by default, with a switch per flag and a note on the read-only rows', async () => {
    await mount()
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(8)
    expect(toggle('labs.agent_secret_request')!.getAttribute('aria-checked')).toBe('false')
    expect(toggle('labsInfo.phoneLivePages')).toBeNull()
    expect(row('labsInfo.phoneLivePages').textContent).toContain('Set on each phone')
    expect(row('labsInfo.snooze').textContent).toContain('Always on')
    expect(container.querySelectorAll('details')).toHaveLength(10)
  })

  it('saves a switch to its labs row and shows it after a reload', async () => {
    await mount()
    await act(async () => toggle('labs.agent_secret_request')!.click())
    expect(set).toHaveBeenCalledWith('labs.agent_secret_request', 'true')
    await unmountAndMount()
    expect(toggle('labs.agent_secret_request')!.getAttribute('aria-checked')).toBe('true')
    expect(row('labs.agent_secret_request').textContent).toContain('On')
  })

  it('returns to the stored value when the write fails', async () => {
    await mount()
    failWrites = true
    await act(async () => toggle('labs.agent_visual_preview')!.click())
    await act(async () => {})
    expect(toggle('labs.agent_visual_preview')!.getAttribute('aria-checked')).toBe('false')
  })

  it('shows an env-forced flag on and disabled, with the reason behind More', async () => {
    rows.set('labs.limit_auto_resume', 'false')
    forced = ['limit_auto_resume']
    await mount()
    const sw = toggle('labs.limit_auto_resume')!
    expect(sw.getAttribute('aria-checked')).toBe('true')
    expect(sw.disabled).toBe(true)
    expect(row('labs.limit_auto_resume').textContent).toContain('Forced on')
    expect(row('labs.limit_auto_resume').textContent).toContain('SB_LIMIT_AUTO_RESUME=1 is set')
    const describedBy = sw.getAttribute('aria-describedby')!.split(' ')
    for (const id of describedBy) expect(document.getElementById(id)).not.toBeNull()
    expect(describedBy.some((id) => id.endsWith('-more'))).toBe(true)
  })

  it('keeps Children on other machines off and disabled while Child chats is off, without touching its row', async () => {
    rows.set('labs.hub_remote_children', 'true')
    await mount()
    const remote = toggle('labs.hub_remote_children')!
    expect(remote.getAttribute('aria-checked')).toBe('false')
    expect(remote.disabled).toBe(true)
    expect(row('labs.hub_remote_children').textContent).toContain('needs Child chats on')

    await act(async () => toggle('labs.hub_children')!.click())
    expect(remote.disabled).toBe(false)
    expect(remote.getAttribute('aria-checked')).toBe('true')
    expect(row('labs.hub_remote_children').textContent).not.toContain('needs Child chats on')
    expect(rows.get('labs.hub_remote_children')).toBe('true')
  })
})

describe('Labs page, dependency over env', () => {
  it('shows a forced child flag off while its parent is off, as the backend reads it', async () => {
    forced = ['hub_remote_children']
    await mount()
    const remote = toggle('labs.hub_remote_children')!
    expect(remote.getAttribute('aria-checked')).toBe('false')
    expect(remote.disabled).toBe(true)
    expect(row('labs.hub_remote_children').textContent).toContain('needs Child chats on')
    expect(row('labs.hub_remote_children').textContent).not.toContain('Forced on ')
  })
})

describe('Labs search', () => {
  it('finds a row by its setting key, env var and warning text', () => {
    expect(searchSettingRows('labs.opencode_v2_acp').map((r) => r.id)).toEqual(['labs.opencode_v2_acp'])
    expect(searchSettingRows('SB_HUB_REMOTE_CHILDREN').map((r) => r.id)).toEqual(['labs.hub_remote_children'])
    expect(searchSettingRows('expose the value').map((r) => r.id)).toEqual(['labs.agent_secret_request'])
  })
})
