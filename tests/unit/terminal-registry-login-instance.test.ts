/**
 * `getOrCreateTerminal` must forward a `loginInstance` identity
 * (agentType + instanceId) to `window.api.terminal.create` untouched, so
 * main can resolve the real provider env across the trusted IPC boundary.
 * The renderer must never build CODEX_HOME/CLAUDE_CONFIG_DIR itself here -
 * this test only checks the identity passthrough, not any env value.
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

import { getOrCreateTerminal } from '../../src/renderer/services/terminal-registry'

function makeApiStub() {
  const create = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      terminal: { create, onOutput: vi.fn(() => () => {}), write: vi.fn(), resize: vi.fn(), kill: vi.fn() },
      routing: { unbind: vi.fn(), bind: vi.fn() },
    },
  }
  return { create }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getOrCreateTerminal - loginInstance identity forwarding', () => {
  it('forwards a codex loginInstance identity to window.api.terminal.create', () => {
    const { create } = makeApiStub()
    getOrCreateTerminal(
      'login-test-1', '/projects/foo', 'codex', undefined, undefined, undefined,
      { agentType: 'codex', instanceId: 'codex-work' },
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'login-test-1',
        loginInstance: { agentType: 'codex', instanceId: 'codex-work' },
      }),
    )
  })

  it('never puts CODEX_HOME/CLAUDE_CONFIG_DIR into env itself when forwarding a loginInstance', () => {
    const { create } = makeApiStub()
    getOrCreateTerminal(
      'login-test-2', '/projects/foo', 'claude', undefined, undefined, undefined,
      { agentType: 'claude-code', instanceId: undefined },
    )
    const call = create.mock.calls[0][0]
    expect(call.env).toBeUndefined()
    expect(call.loginInstance).toEqual({ agentType: 'claude-code', instanceId: undefined })
  })

  it('omits loginInstance when not provided (regular non-login terminals unaffected)', () => {
    const { create } = makeApiStub()
    getOrCreateTerminal('login-test-3', '/projects/foo', 'bash')
    const call = create.mock.calls[0][0]
    expect(call.loginInstance).toBeUndefined()
  })
})
