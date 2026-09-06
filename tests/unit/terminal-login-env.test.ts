/**
 * `withResolvedLoginEnv` is the seam the Terminal-tab "Start Terminal
 * Session" login flow (UnifiedProviderPicker.tsx) uses so the in-app Login
 * action never builds raw provider env in the renderer. The renderer only
 * sends *identity* (agentType + instanceId) across the trusted IPC
 * boundary; main resolves the instance and merges its real env (CODEX_HOME
 * / CLAUDE_CONFIG_DIR, etc.) before the PTY spawns.
 *
 * Profile-isolation bug this pins: before this seam existed,
 * UnifiedProviderPicker only ever set CLAUDE_CONFIG_DIR by hand and never
 * touched CODEX_HOME at all - a Codex login terminal always ran against
 * whatever ambient/default CODEX_HOME happened to be set, silently
 * crossing accounts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderInstanceRow } from '../../src/main/db/providerInstances'

const resolveProviderInstance = vi.fn()
const resolveInstanceEnv = vi.fn()

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (...args: unknown[]) => resolveProviderInstance(...args),
}))

vi.mock('../../src/main/provider/instance-env', () => ({
  resolveInstanceEnv: (...args: unknown[]) => resolveInstanceEnv(...args),
}))

function codexRow(overrides: Partial<ProviderInstanceRow> = {}): ProviderInstanceRow {
  return {
    id: 'codex-work',
    agentType: 'codex',
    displayName: 'Work',
    accentColor: null,
    authMode: 'oauth_dir',
    env: {},
    oauthDir: '/Users/tejas/.codex-work',
    configJson: null,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('withResolvedLoginEnv', () => {
  it('returns opts unchanged when no loginInstance identity is present', async () => {
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const opts = { id: 't1', cwd: '/x' }
    expect(withResolvedLoginEnv(opts)).toBe(opts)
    expect(resolveProviderInstance).not.toHaveBeenCalled()
  })

  it('resolves the requested codex instance and merges CODEX_HOME into opts.env', async () => {
    resolveProviderInstance.mockReturnValue(codexRow())
    resolveInstanceEnv.mockReturnValue({ CODEX_HOME: '/Users/tejas/.codex-work', PATH: '/usr/bin' })
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const result = withResolvedLoginEnv({
      id: 't2',
      loginInstance: { agentType: 'codex', instanceId: 'codex-work' },
    })
    expect(resolveProviderInstance).toHaveBeenCalledWith('codex', 'codex-work')
    expect(result.env?.CODEX_HOME).toBe('/Users/tejas/.codex-work')
  })

  it('resolves an absolute, non-tilde CODEX_HOME for the default instance', async () => {
    resolveProviderInstance.mockReturnValue(codexRow({ id: 'codex-default', oauthDir: null }))
    resolveInstanceEnv.mockReturnValue({ CODEX_HOME: '/Users/tejas/.codex' })
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const result = withResolvedLoginEnv({
      id: 't3',
      loginInstance: { agentType: 'codex', instanceId: undefined },
    })
    expect(result.env?.CODEX_HOME).toBe('/Users/tejas/.codex')
    expect(result.env?.CODEX_HOME.startsWith('~')).toBe(false)
  })

  it('never lets a renderer/launch-config env override the main-resolved CODEX_HOME', async () => {
    // Renderer-supplied env (e.g. a launch config's env block) must not be
    // able to redirect a login terminal to a different credential home than
    // the one main resolved for the requested instance - that would let a
    // stale/forged env value cross accounts silently.
    resolveProviderInstance.mockReturnValue(codexRow())
    resolveInstanceEnv.mockReturnValue({ CODEX_HOME: '/Users/tejas/.codex-work' })
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const result = withResolvedLoginEnv({
      id: 't4',
      env: { CODEX_HOME: '/explicit/override' },
      loginInstance: { agentType: 'codex', instanceId: 'codex-work' },
    })
    expect(result.env?.CODEX_HOME).toBe('/Users/tejas/.codex-work')
  })

  it('never lets a renderer/launch-config env override the main-resolved CLAUDE_CONFIG_DIR', async () => {
    resolveProviderInstance.mockReturnValue(codexRow({ agentType: 'claude-code', id: 'claude-work' }))
    resolveInstanceEnv.mockReturnValue({ CLAUDE_CONFIG_DIR: '/Users/tejas/.claude-work' })
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const result = withResolvedLoginEnv({
      id: 't4b',
      env: { CLAUDE_CONFIG_DIR: '/explicit/override' },
      loginInstance: { agentType: 'claude-code', instanceId: 'claude-work' },
    })
    expect(result.env?.CLAUDE_CONFIG_DIR).toBe('/Users/tejas/.claude-work')
  })

  it('still merges unrelated env vars from opts.env alongside the resolved credential key', async () => {
    resolveProviderInstance.mockReturnValue(codexRow())
    resolveInstanceEnv.mockReturnValue({ CODEX_HOME: '/Users/tejas/.codex-work' })
    const { withResolvedLoginEnv } = await import('../../src/main/ipc/terminal-login-env')
    const result = withResolvedLoginEnv({
      id: 't4c',
      env: { CODEX_HOME: '/explicit/override', TERM: 'xterm-256color', CUSTOM_VAR: 'yes' },
      loginInstance: { agentType: 'codex', instanceId: 'codex-work' },
    })
    expect(result.env?.CODEX_HOME).toBe('/Users/tejas/.codex-work')
    expect(result.env?.TERM).toBe('xterm-256color')
    expect(result.env?.CUSTOM_VAR).toBe('yes')
  })

  it('throws a TerminalLoginInstanceError (not a silent fallback) when resolution throws for an explicit bad id', async () => {
    resolveProviderInstance.mockImplementation(() => {
      throw new Error('invalid instance: wrong kind')
    })
    const { withResolvedLoginEnv, TerminalLoginInstanceError } = await import('../../src/main/ipc/terminal-login-env')
    expect(() => withResolvedLoginEnv({
      id: 't5',
      loginInstance: { agentType: 'claude-code', instanceId: 'codex-work' },
    })).toThrow(TerminalLoginInstanceError)
    expect(resolveInstanceEnv).not.toHaveBeenCalled()
  })

  it('throws a TerminalLoginInstanceError when resolution returns nothing usable', async () => {
    resolveProviderInstance.mockReturnValue(null)
    const { withResolvedLoginEnv, TerminalLoginInstanceError } = await import('../../src/main/ipc/terminal-login-env')
    expect(() => withResolvedLoginEnv({
      id: 't6',
      loginInstance: { agentType: 'codex', instanceId: 'ghost' },
    })).toThrow(TerminalLoginInstanceError)
  })
})
