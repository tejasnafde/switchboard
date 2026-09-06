/**
 * `startTerminalSession` orchestrates the Terminal-tab "Start Terminal
 * Session" button in UnifiedProviderPicker.tsx. Confirmed bug this pins:
 * the button used to fire `getOrCreateTerminal` (a synchronous,
 * fire-and-forget call) and immediately add an agent-store session, set it
 * active, and persist a conversation row - all before the underlying
 * `terminal:create` IPC call had even resolved. A rejected create (missing/
 * disabled/wrong-kind login instance) then left an unhandled promise
 * rejection AND a dead session/conversation in the UI with no working PTY
 * behind it.
 *
 * The fix awaits terminal creation FIRST and only creates the
 * session/store/conversation/event artifacts after it succeeds, so a
 * rejection never leaves anything provisional behind and is always
 * surfaced as a normal (non-throwing) result the caller can render.
 *
 * Dependencies are injected so this is testable without React, xterm, or
 * Electron IPC.
 */
import { describe, it, expect, vi } from 'vitest'
import { startTerminalSession } from '../../src/renderer/shared/terminalLoginStart'

function makeDeps(overrides: Partial<Parameters<typeof startTerminalSession>[0]> = {}) {
  return {
    createTerminal: vi.fn().mockResolvedValue(undefined),
    addSession: vi.fn(),
    setActiveSession: vi.fn(),
    createConversation: vi.fn().mockResolvedValue(undefined),
    emitSessionCreated: vi.fn(),
    now: () => 1000,
    ...overrides,
  }
}

const baseParams = {
  projectPath: '/repos/app',
  machineId: undefined,
  command: 'codex',
  loginInstance: { agentType: 'codex' as const, instanceId: 'codex-work' },
  instanceId: 'codex-work',
}

describe('startTerminalSession - success path', () => {
  it('awaits terminal creation before creating any session/store artifact', async () => {
    const order: string[] = []
    const deps = makeDeps({
      createTerminal: vi.fn().mockImplementation(async () => { order.push('createTerminal') }),
      addSession: vi.fn().mockImplementation(() => order.push('addSession')),
      setActiveSession: vi.fn().mockImplementation(() => order.push('setActiveSession')),
    })
    const result = await startTerminalSession(deps, baseParams)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['createTerminal', 'addSession', 'setActiveSession'])
  })

  it('forwards the login instance identity to createTerminal untouched', async () => {
    const deps = makeDeps()
    await startTerminalSession(deps, baseParams)
    expect(deps.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      '/repos/app',
      'codex',
      undefined,
      { agentType: 'codex', instanceId: 'codex-work' },
    )
  })

  it('persists a conversation row and emits the created event after success', async () => {
    const deps = makeDeps()
    await startTerminalSession(deps, baseParams)
    expect(deps.setActiveSession).toHaveBeenCalled()
    expect(deps.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/repos/app', agentType: 'terminal', title: 'codex' }),
    )
    expect(deps.emitSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/repos/app', title: 'codex', source: 'switchboard', agentType: 'terminal' }),
    )
  })

  it('never rejects even if createConversation rejects (fire-and-forget persistence)', async () => {
    const deps = makeDeps({ createConversation: vi.fn().mockRejectedValue(new Error('db down')) })
    await expect(startTerminalSession(deps, baseParams)).resolves.toEqual({ ok: true })
  })
})

describe('startTerminalSession - rejected terminal:create', () => {
  it('resolves with ok:false and a useful error instead of throwing', async () => {
    const deps = makeDeps({
      createTerminal: vi.fn().mockRejectedValue(new Error('No enabled codex instance available to log in with.')),
    })
    const result = await startTerminalSession(deps, baseParams)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('No enabled codex instance available to log in with.')
  })

  it('never creates a session, never sets it active, and never persists a conversation on rejection', async () => {
    const deps = makeDeps({ createTerminal: vi.fn().mockRejectedValue(new Error('disabled')) })
    await startTerminalSession(deps, baseParams)
    expect(deps.addSession).not.toHaveBeenCalled()
    expect(deps.setActiveSession).not.toHaveBeenCalled()
    expect(deps.createConversation).not.toHaveBeenCalled()
    expect(deps.emitSessionCreated).not.toHaveBeenCalled()
  })

  it('produces no unhandled rejection - the returned promise always resolves', async () => {
    const deps = makeDeps({ createTerminal: vi.fn().mockRejectedValue('a raw string rejection') })
    await expect(startTerminalSession(deps, baseParams)).resolves.toEqual({
      ok: false,
      error: 'a raw string rejection',
    })
  })
})
