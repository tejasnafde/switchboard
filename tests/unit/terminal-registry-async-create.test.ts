/**
 * `createTerminalAsync` backs the Terminal-tab "Start Terminal Session"
 * flow (via startTerminalSession in terminalLoginStart.ts). Unlike
 * `getOrCreateTerminal` (fire-and-forget, used throughout the rest of the
 * app - see terminal-registry-env.test.ts / terminal-registry-login-
 * instance.test.ts, which must keep passing unchanged), this awaits the
 * `terminal:create` IPC call and only registers the xterm instance in the
 * registry on success. On rejection it must:
 *   - propagate the rejection to the caller (no unhandled promise - the
 *     caller, startTerminalSession, already turns this into a normal
 *     ok:false result)
 *   - leave NO registry entry behind (so a later getOrCreateTerminal for
 *     the same id doesn't find a half-created ghost instance)
 *   - unbind any routing-table entry it bound before the failed create, so
 *     a remote pane id doesn't stay routed to a machine with no PTY behind
 *     it
 *
 * Same DOM/xterm stubbing approach as terminal-registry-env.test.ts (this
 * project's vitest config runs in the `node` environment; xterm needs a
 * browser).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

if (typeof document === 'undefined') {
  const el = { className: '', style: {} }
  ;(globalThis as unknown as Record<string, unknown>).document = {
    documentElement: el,
    createElement: () => el,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}
if (typeof getComputedStyle === 'undefined') {
  ;(globalThis as unknown as Record<string, unknown>).getComputedStyle = () => ({
    getPropertyValue: () => '',
  })
}

vi.mock('@xterm/xterm', () => {
  const Terminal = vi.fn(() => ({
    loadAddon: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    options: {},
    element: document.createElement('div'),
  }))
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(),
  })),
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { createTerminalAsync, hasTerminal } from '../../src/renderer/services/terminal-registry'

function makeApiStub() {
  const create = vi.fn()
  const bind = vi.fn()
  const unbind = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      terminal: { create, onOutput: vi.fn(() => () => {}), write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
      routing: { bind, unbind },
    },
  }
  return { create, bind, unbind }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createTerminalAsync - success', () => {
  it('awaits terminal:create and registers the instance only after it resolves', async () => {
    const { create } = makeApiStub()
    create.mockResolvedValue({ id: 'async-1' })
    expect(hasTerminal('async-1')).toBe(false)
    const instance = await createTerminalAsync('async-1', '/projects/foo', 'codex', undefined, {
      agentType: 'codex', instanceId: 'codex-work',
    })
    expect(instance).toBeDefined()
    expect(hasTerminal('async-1')).toBe(true)
  })

  it('forwards the login instance identity in the create payload', async () => {
    const { create } = makeApiStub()
    create.mockResolvedValue({ id: 'async-2' })
    await createTerminalAsync('async-2', '/projects/foo', 'claude', undefined, {
      agentType: 'claude-code', instanceId: undefined,
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'async-2', loginInstance: { agentType: 'claude-code', instanceId: undefined } }),
    )
  })

  it('binds routing before create when a remote machineId is given', async () => {
    const { create, bind } = makeApiStub()
    create.mockResolvedValue({ id: 'async-3' })
    await createTerminalAsync('async-3', '/projects/foo', 'codex', 'vm-1', undefined)
    expect(bind).toHaveBeenCalledWith('async-3', 'vm-1')
  })
})

describe('createTerminalAsync - rejection', () => {
  it('propagates the rejection to the caller instead of swallowing it', async () => {
    const { create } = makeApiStub()
    create.mockRejectedValue(new Error('No enabled codex instance available to log in with.'))
    await expect(
      createTerminalAsync('async-4', '/projects/foo', 'codex', undefined, { agentType: 'codex', instanceId: 'ghost' }),
    ).rejects.toThrow('No enabled codex instance available to log in with.')
  })

  it('leaves no registry entry behind on rejection', async () => {
    const { create } = makeApiStub()
    create.mockRejectedValue(new Error('disabled'))
    await createTerminalAsync('async-5', '/projects/foo', 'codex', undefined, undefined).catch(() => {})
    expect(hasTerminal('async-5')).toBe(false)
  })

  it('unbinds the routing-table entry it bound before the failed create', async () => {
    const { create, bind, unbind } = makeApiStub()
    create.mockRejectedValue(new Error('disabled'))
    await createTerminalAsync('async-6', '/projects/foo', 'codex', 'vm-1', undefined).catch(() => {})
    expect(bind).toHaveBeenCalledWith('async-6', 'vm-1')
    expect(unbind).toHaveBeenCalledWith('async-6')
  })
})
