/**
 * Agent / OAuth-profile selection on the mobile client.
 */
import { describe, it, expect } from 'vitest'
import { profilesFor, agentTypeFor } from '../../apps/mobile/src/lib/profiles'
import type { ProviderInstance } from '../../src/shared/types'

function inst(over: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'x',
    agentType: 'claude-code',
    displayName: 'X',
    accentColor: null,
    authMode: 'oauth_dir',
    envKeys: [],
    oauthDir: null,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('agentTypeFor', () => {
  it('maps each provider kind to its DB agent type', () => {
    expect(agentTypeFor('claude')).toBe('claude-code')
    expect(agentTypeFor('codex')).toBe('codex')
    expect(agentTypeFor('opencode')).toBe('opencode')
  })
})

describe('profilesFor', () => {
  it('keeps only the chosen agent, so Codex profiles cannot appear under Claude', () => {
    const rows = [
      inst({ id: 'a', agentType: 'claude-code', displayName: 'Personal' }),
      inst({ id: 'b', agentType: 'codex', displayName: 'Work' }),
    ]
    expect(profilesFor(rows, 'claude').map((i) => i.id)).toEqual(['a'])
    expect(profilesFor(rows, 'codex').map((i) => i.id)).toEqual(['b'])
  })

  it('hides disabled profiles', () => {
    const rows = [
      inst({ id: 'on', displayName: 'On' }),
      inst({ id: 'off', displayName: 'Off', enabled: false }),
    ]
    expect(profilesFor(rows, 'claude').map((i) => i.id)).toEqual(['on'])
  })

  it('puts the seed default first, then alphabetical - matching the desktop picker', () => {
    const rows = [
      inst({ id: 'zeta', displayName: 'Zeta' }),
      inst({ id: 'claude-code-default', displayName: 'Default' }),
      inst({ id: 'alpha', displayName: 'Alpha' }),
    ]
    expect(profilesFor(rows, 'claude').map((i) => i.displayName)).toEqual(['Default', 'Alpha', 'Zeta'])
  })

  it('returns empty when a backend has none for that agent', () => {
    expect(profilesFor([], 'claude')).toEqual([])
    expect(profilesFor([inst({ agentType: 'codex' })], 'opencode')).toEqual([])
  })
})
