/**
 * `legacyInstanceBelongsToAgent` backs the NewSessionScreen machine-default
 * prefill (`SwitchboardClient.getSessionDefaults`): the pre-scoping global
 * default key must only ever be honored for the agent kind that actually
 * owns the instance it names, or a Codex pick made before per-agent scoping
 * existed would prefill a brand-new Claude/OpenCode session with it.
 */
import type { ProviderInstance } from '@shared/types'
import { legacyInstanceBelongsToAgent } from '../profiles'

function instance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'codex-personal',
    agentType: 'codex',
    displayName: 'Personal Codex',
    accentColor: null,
    authMode: 'env',
    envKeys: [],
    oauthDir: null,
    effectiveOauthDir: null,
    effectiveOauthDirSource: 'default',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('legacyInstanceBelongsToAgent', () => {
  it('is false when nothing was ever stored', () => {
    expect(legacyInstanceBelongsToAgent([instance()], undefined, 'claude-code')).toBe(false)
  })

  it('is false when the legacy id belongs to a different agent kind', () => {
    expect(legacyInstanceBelongsToAgent([instance()], 'codex-personal', 'claude-code')).toBe(false)
  })

  it('is true when the legacy id still belongs to the requested agent kind', () => {
    expect(legacyInstanceBelongsToAgent([instance()], 'codex-personal', 'codex')).toBe(true)
  })

  it('is false when the legacy id no longer exists at all', () => {
    expect(legacyInstanceBelongsToAgent([instance()], 'deleted-id', 'codex')).toBe(false)
  })
})
