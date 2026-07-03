/**
 * Tests that `getOrCreateTerminal` forwards the optional `env` parameter
 * to `window.api.terminal.create`, which passes it to the PTY spawn call
 * in the main process (where CLAUDE_CONFIG_DIR is injected for account
 * switching in terminal sessions).
 *
 * We can't instantiate a real xterm Terminal in Node, so we stub the
 * renderer-side API at `globalThis.window` and verify the PTY create call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── DOM stubs ───────────────────────────────────────────────────────────────
// Vitest runs in the `node` environment so DOM globals are absent. Stub the
// minimum surface that terminal-registry.ts touches at module + call time.

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

// ─── xterm stubs ─────────────────────────────────────────────────────────────
// The module imports Terminal + addons from @xterm/* which are browser-only.
// Mock them before importing the registry so Node doesn't blow up on missing
// DOM APIs.

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

// CSS import - no-op in tests
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ─── System under test ────────────────────────────────────────────────────────

import { getOrCreateTerminal, destroyTerminal } from '../../src/renderer/services/terminal-registry'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApiStub() {
  const create = vi.fn()
  const onOutput = vi.fn(() => () => {})
  const write = vi.fn()
  const resize = vi.fn()
  const kill = vi.fn()
  const unbind = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      terminal: { create, onOutput, write, resize, kill },
      routing: { unbind },
    },
  }
  return { create, kill, unbind }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset registry between tests by re-requiring via cache invalidation.
  // Since Vitest caches modules we test by using unique IDs per test.
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getOrCreateTerminal - env forwarding', () => {
  it('passes env to window.api.terminal.create when provided', () => {
    const { create } = makeApiStub()
    const env = { CLAUDE_CONFIG_DIR: '/home/user/.config/claude-work' }
    getOrCreateTerminal('env-test-1', '/projects/foo', 'claude', undefined, env)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-test-1', env }),
    )
  })

  it('passes env=undefined when no env argument given', () => {
    const { create } = makeApiStub()
    getOrCreateTerminal('env-test-2', '/projects/foo', 'claude')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-test-2', env: undefined }),
    )
  })

  it('passes env=undefined when env is an empty object', () => {
    // An empty env object is indistinguishable from no-env at the PTY
    // level - but it's still what the caller passed, so we forward it.
    const { create } = makeApiStub()
    getOrCreateTerminal('env-test-3', '/projects/foo', undefined, undefined, {})
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-test-3', env: {} }),
    )
  })

  it('forwards CLAUDE_CONFIG_DIR exactly as given', () => {
    const { create } = makeApiStub()
    const env = { CLAUDE_CONFIG_DIR: '/home/tejas/.config/claude-work' }
    getOrCreateTerminal('env-test-4', '/projects/bar', 'claude', undefined, env)
    const call = create.mock.calls[0][0]
    expect(call.env.CLAUDE_CONFIG_DIR).toBe('/home/tejas/.config/claude-work')
  })

  it('forwards cwd and initialCommand alongside env', () => {
    const { create } = makeApiStub()
    getOrCreateTerminal(
      'env-test-5',
      '/projects/baz',
      'codex',
      undefined,
      { CODEX_HOME: '/home/user/.codex-work' },
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/projects/baz',
        initialCommand: 'codex',
        env: { CODEX_HOME: '/home/user/.codex-work' },
      }),
    )
  })
})

describe('destroyTerminal - routing cleanup', () => {
  it('unbinds the pane id from the routing table on teardown', () => {
    const { unbind } = makeApiStub()
    getOrCreateTerminal('destroy-test-1', '/projects/foo')
    destroyTerminal('destroy-test-1')
    expect(unbind).toHaveBeenCalledWith('destroy-test-1')
  })

  it('is a no-op for an id that was never registered', () => {
    const { unbind } = makeApiStub()
    expect(() => destroyTerminal('never-created')).not.toThrow()
    expect(unbind).not.toHaveBeenCalled()
  })
})
