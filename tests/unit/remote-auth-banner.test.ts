/**
 * Unit tests for the pure decision + cache-key logic behind the proactive
 * remote-auth banner (`RemoteAuthBanner.tsx`). The React component itself is
 * a thin shell around these helpers, so no DOM tests are needed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  shouldShowRemoteAuthBanner,
  remoteAuthCacheKey,
  invalidateRemoteAuthCache,
  type RemoteAuthCheckResult,
} from '../../src/renderer/components/chat/RemoteAuthBanner'

const notLoggedIn: RemoteAuthCheckResult = {
  loggedIn: false,
  loginCommand: 'CLAUDE_CONFIG_DIR="$HOME/.claude" claude',
  configDir: '/home/vm/.claude',
}
const loggedIn: RemoteAuthCheckResult = { loggedIn: true }

describe('shouldShowRemoteAuthBanner', () => {
  it('never shows for a local session, even when the check says not logged in', () => {
    expect(shouldShowRemoteAuthBanner({ machineId: 'local', agentType: 'claude-code' }, notLoggedIn)).toBe(false)
  })

  it('never shows when the session has no machineId (implicit local)', () => {
    expect(shouldShowRemoteAuthBanner({ agentType: 'claude-code' }, notLoggedIn)).toBe(false)
    expect(shouldShowRemoteAuthBanner({ machineId: undefined, agentType: 'claude-code' }, notLoggedIn)).toBe(false)
  })

  it('shows for a remote claude session that is not logged in', () => {
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'claude-code' }, notLoggedIn)).toBe(true)
  })

  it('hides for a remote claude session that IS logged in', () => {
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'claude-code' }, loggedIn)).toBe(false)
  })

  it('never shows for remote codex or opencode sessions', () => {
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'codex' }, notLoggedIn)).toBe(false)
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'opencode' }, notLoggedIn)).toBe(false)
  })

  it('never shows when the check is null or undefined (probe pending or failed)', () => {
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'claude-code' }, null)).toBe(false)
    expect(shouldShowRemoteAuthBanner({ machineId: 'vm-1', agentType: 'claude-code' }, undefined)).toBe(false)
  })

  it('never shows when the session is null or undefined', () => {
    expect(shouldShowRemoteAuthBanner(null, notLoggedIn)).toBe(false)
    expect(shouldShowRemoteAuthBanner(undefined, notLoggedIn)).toBe(false)
  })
})

describe('remoteAuthCacheKey', () => {
  it('keys by machine and config segment', () => {
    expect(remoteAuthCacheKey('vm-1', '.claude-work')).toBe('vm-1::.claude-work')
  })

  it('falls back to .claude for a missing segment, matching the remote default dir', () => {
    expect(remoteAuthCacheKey('vm-1', null)).toBe('vm-1::.claude')
    expect(remoteAuthCacheKey('vm-1', undefined)).toBe('vm-1::.claude')
  })

  it('separates the same segment on different machines', () => {
    expect(remoteAuthCacheKey('vm-1', '.claude')).not.toBe(remoteAuthCacheKey('vm-2', '.claude'))
  })
})

describe('invalidateRemoteAuthCache', () => {
  beforeEach(() => {
    invalidateRemoteAuthCache()
  })

  it('is callable per-machine and globally without throwing on an empty cache', () => {
    expect(() => invalidateRemoteAuthCache('vm-1')).not.toThrow()
    expect(() => invalidateRemoteAuthCache()).not.toThrow()
  })
})
