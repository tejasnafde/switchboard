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
import { ConfirmHost } from '../../src/renderer/components/ui/confirm'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let rows: Map<string, string>
let forced: string[]
let failWrites: boolean
const bridgeProjects = vi.fn()
const setProjectAllowed = vi.fn()
const removeBridgeProject = vi.fn()
const deviceStatus = vi.fn()
const enrollDevice = vi.fn()
const removeDevice = vi.fn()
const bridgeChecks = vi.fn()
const setBridgeChecks = vi.fn()
const stopStatus = vi.fn()
const stopAll = vi.fn()
const clearKill = vi.fn()
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

const DEVICE = {
  enabled: true,
  enrolled: false,
  machine_id: 'hub-1',
  label: null,
  public_key: null,
  key_fingerprint: null,
  relay_origin: 'https://bridge.tn07.dev',
  state: 'not_enrolled',
  code: null,
  connection_generation: null,
  operator_command: null,
}

const STOP = {
  killed: false,
  stop_generation: 0,
  kill_pending: false,
  enrolled: true,
  last_result: null,
  active_chats: 0,
  last_contact_at: null,
  lease_expires_at: null,
  clear_command: null,
}

beforeEach(() => {
  deviceStatus.mockResolvedValue({ ...DEVICE, enabled: false, state: 'off' })
  bridgeChecks.mockResolvedValue({ enabled: true, projects: [] })
  stopStatus.mockResolvedValue(STOP)
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
      bridge: {
        listProjects: bridgeProjects,
        setProjectAllowed,
        removeProject: removeBridgeProject,
        listChecks: bridgeChecks,
        setChecks: setBridgeChecks,
        deviceStatus,
        enrollDevice,
        setDeviceLabel: vi.fn(),
        removeDevice,
        stopStatus,
        stopAll,
        clearKill,
      },
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
  return createElement(
    'div',
    null,
    createElement(LabsPage, { values, set: setValue, highlight: null }),
    createElement(ConfirmHost),
  )
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
    const project = { path: '/repo', name: 'repo', projectId: 'bproj_1', orphan: false }
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

  it('lists the configured checks with what was measured, and adds one as a program and arguments', async () => {
    rows.set('labs.instinct_bridge', 'true')
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [] })
    const project = {
      project_id: 'bproj_1',
      label: 'repo',
      checks: [{ name: 'tests', program: 'npm', args: ['test'] }],
      results: [{ name: 'tests', status: 'measured', outcome: 'failed', exit_code: 1, at: 1_700_000_000_000 }],
    }
    bridgeChecks.mockResolvedValue({ enabled: true, projects: [project] })
    setBridgeChecks.mockResolvedValue({ enabled: true, projects: [project] })
    await mount()
    const panel = container.querySelector('[data-testid="bridge-checks"]')!
    expect(panel.textContent).toContain('npm test')
    expect(panel.textContent).toContain('Failed (exit 1)')

    const field = (label: string) => panel.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
    for (const [label, value] of [
      ['Check name for repo', 'lint'],
      ['Check program for repo', 'npm'],
      ['Check arguments for repo', ' run  lint '],
    ] as const) {
      const input = field(label)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const add = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Add')!
    await act(async () => add.click())
    expect(setBridgeChecks).toHaveBeenCalledWith('bproj_1', [
      { name: 'tests', program: 'npm', args: ['test'] },
      { name: 'lint', program: 'npm', args: ['run', 'lint'] },
    ])
  })

  it('lists an orphaned bridge project as allowed and removes it by id', async () => {
    const orphan = { path: '/gone', name: 'gone', projectId: 'bproj_2', allowed: true, orphan: true }
    rows.set('labs.instinct_bridge', 'true')
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [orphan] })
    removeBridgeProject.mockResolvedValue({ enabled: true, projects: [] })
    await mount()
    const panel = container.querySelector('[data-testid="bridge-projects"]')!
    expect(panel.textContent).toContain('Untick to remove it')
    const box = panel.querySelector<HTMLButtonElement>('[role="checkbox"]')!
    expect(box.getAttribute('aria-checked')).toBe('true')
    await act(async () => box.click())
    expect(removeBridgeProject).toHaveBeenCalledWith('bproj_2')
    expect(setProjectAllowed).not.toHaveBeenCalled()
  })

  it('enrolls this Mac and shows the machine id, the operator command and the status', async () => {
    rows.set('labs.instinct_bridge', 'true')
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [] })
    deviceStatus.mockResolvedValue(DEVICE)
    const enrolled = {
      ...DEVICE,
      enrolled: true,
      label: 'Work Mac',
      public_key: 'AAAA',
      key_fingerprint: '0123456789abcdef',
      state: 'rejected',
      code: 'not_enrolled',
      operator_command: "echo 'AAAA' | node scripts/bridge-operator.mjs enroll 'hub-1' 'Work Mac' -",
    }
    enrollDevice.mockResolvedValue(enrolled)
    await mount()
    const panel = container.querySelector('[data-testid="bridge-device"]')!
    expect(panel.textContent).toContain('hub-1')
    expect(panel.querySelector('[data-testid="bridge-device-status"]')!.textContent).toBe('Not enrolled')
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Device label"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Work Mac')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const enroll = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Enroll this Mac')!
    await act(async () => enroll.click())
    expect(enrollDevice).toHaveBeenCalledWith('Work Mac')
    expect(panel.querySelector('[data-testid="bridge-operator-command"]')!.textContent).toBe(enrolled.operator_command)
    expect(panel.querySelector('[data-testid="bridge-device-status"]')!.textContent).toBe(
      'Refused by the relay (not_enrolled). Trying again later.',
    )
    expect([...panel.querySelectorAll('button')].some((b) => b.textContent === 'Remove enrollment')).toBe(true)
  })

  it('stops all bridge work after the confirm and shows the kill with the operator command', async () => {
    rows.set('labs.instinct_bridge', 'true')
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [] })
    deviceStatus.mockResolvedValue(DEVICE)
    stopAll.mockResolvedValue({
      ...STOP,
      killed: true,
      stop_generation: 3,
      kill_pending: true,
      last_result: {
        generation: 3,
        state: 'unconfirmed',
        unconfirmed: ['c1'],
        unconfirmed_titles: ['Fix the header'],
        stopped: 1,
        at: 1,
      },
      clear_command: 'node scripts/bridge-operator.mjs clear-kill',
    })
    await mount()
    const panel = container.querySelector('[data-testid="bridge-stop"]')!
    expect(panel.textContent).toContain('also interrupts a turn you started when the bridge steered')
    expect(panel.querySelector('[data-testid="bridge-stop-killed"]')!.textContent).toBe('Allowed')
    const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
    await act(async () => button('Stop all bridge work').click())
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Stop all bridge work?')
    await act(async () => button('Cancel').click())
    expect(stopAll).not.toHaveBeenCalled()
    await act(async () => button('Stop all bridge work').click())
    await act(async () => button('Stop all').click())
    expect(stopAll).toHaveBeenCalledTimes(1)
    expect(panel.querySelector('[data-testid="bridge-stop-killed"]')!.textContent).toBe(
      'Stopped. New bridge work is refused.',
    )
    expect(panel.querySelector('[data-testid="bridge-stop-generation"]')!.textContent).toBe(
      '3 (not sent to the relay yet)',
    )
    expect(panel.querySelector('[data-testid="bridge-stop-result"]')!.textContent).toBe(
      'Not confirmed for: Fix the header',
    )
    expect(panel.querySelector('[data-testid="bridge-clear-command"]')!.textContent).toBe(
      'node scripts/bridge-operator.mjs clear-kill',
    )
    expect(button('Allow bridge work again')).toBeUndefined()
  })

  it('keeps the stop panel with the flag off while a kill is still in force', async () => {
    stopStatus.mockResolvedValue({ ...STOP, killed: true, stop_generation: 2, enrolled: false })
    clearKill.mockResolvedValue({ ...STOP, stop_generation: 2, enrolled: false })
    await mount()
    expect(rows.get('labs.instinct_bridge')).toBeUndefined()
    // The flag refuses new bridge work; it must not hide the only control that clears the kill.
    expect(container.querySelector('[data-testid="bridge-device"]')).toBeNull()
    expect(container.querySelector('[data-testid="bridge-stop-killed"]')!.textContent).toBe(
      'Stopped. New bridge work is refused.',
    )
    const allow = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow bridge work again')!
    await act(async () => allow.click())
    expect(clearKill).toHaveBeenCalledTimes(1)
  })

  it('hides the stop panel with the flag off on a Mac that never ran bridge work', async () => {
    stopStatus.mockResolvedValue({ ...STOP, enrolled: false })
    await mount()
    expect(container.querySelector('[data-testid="bridge-stop"]')).toBeNull()
  })

  it('keeps the stop panel with the flag off while a bridge chat is still active', async () => {
    stopStatus.mockResolvedValue({ ...STOP, enrolled: false, active_chats: 1 })
    await mount()
    expect(container.querySelector('[data-testid="bridge-stop"]')).not.toBeNull()
  })

  it('clears a kill locally on a Mac that is not enrolled', async () => {
    rows.set('labs.instinct_bridge', 'true')
    bridgeProjects.mockResolvedValue({ enabled: true, projects: [] })
    deviceStatus.mockResolvedValue(DEVICE)
    stopStatus.mockResolvedValue({ ...STOP, killed: true, stop_generation: 1, enrolled: false })
    clearKill.mockResolvedValue({ ...STOP, stop_generation: 1, enrolled: false })
    await mount()
    const allow = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow bridge work again')!
    await act(async () => allow.click())
    expect(clearKill).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="bridge-stop-killed"]')!.textContent).toBe('Allowed')
  })

  it('clears a failed status read at the next good poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      rows.set('labs.instinct_bridge', 'true')
      bridgeProjects.mockResolvedValue({ enabled: true, projects: [] })
      deviceStatus.mockRejectedValueOnce(new Error('backend gone')).mockResolvedValue(DEVICE)
      await mount()
      const panel = () => container.querySelector('[data-testid="bridge-device"]')!
      expect(panel().querySelector('[role="alert"]')!.textContent).toBe('Could not read the enrollment.')
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      expect(panel().querySelector('[role="alert"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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
