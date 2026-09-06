/**
 * The confirmed critical bug: `SETTING_DEFAULT_INSTANCE_ID` was one
 * machine-wide key. Picking a Codex profile as the machine default and then
 * starting a fresh Claude, OpenCode, kanban-launched, or phone-started
 * session all resolve through the same `sessionDefaultsFor` -> the wrong-kind
 * Codex id landed in `resolveProviderInstance`, which now THROWS instead of
 * silently substituting - so the new session failed to start at all.
 *
 * `resolveProviderInstance` itself (src/main/db/providerInstances.ts) stays
 * untouched and strict; the fix is entirely in what `machineDefaults` reads,
 * so a same-kind conversation-history-less start never sees a foreign id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderInstanceRow } from '../../src/main/db/providerInstances'
import { defaultInstanceSettingKey, SETTING_DEFAULT_INSTANCE_ID } from '../../src/shared/session-defaults'

const settings = new Map<string, string>()
const rows = new Map<string, ProviderInstanceRow>()

function codexRow(overrides: Partial<ProviderInstanceRow> = {}): ProviderInstanceRow {
  return {
    id: 'codex-personal',
    agentType: 'codex',
    displayName: 'Personal Codex',
    accentColor: null,
    authMode: 'oauth_dir',
    env: {},
    oauthDir: '/tmp/codex-personal',
    configJson: null,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

vi.mock('../../src/main/db/providerInstances', () => ({
  getProviderInstanceFull: vi.fn((id: string) => rows.get(id) ?? null),
}))

vi.mock('../../src/main/db/database', () => ({
  getSetting: vi.fn((key: string) => settings.get(key) ?? null),
  getConversationAgentType: vi.fn(() => null),
  getConversationModel: vi.fn(() => null),
  getConversationProviderInstanceId: vi.fn(() => null),
  getConversationRuntimeMode: vi.fn(() => null),
}))

import { sessionDefaultsFor } from '../../src/main/provider/session-defaults'

describe('sessionDefaultsFor - machine-level instance default is agent-scoped', () => {
  beforeEach(() => {
    settings.clear()
    rows.clear()
  })

  it('does not hand a Codex machine default to a brand-new Claude session', () => {
    rows.set('codex-personal', codexRow())
    settings.set(SETTING_DEFAULT_INSTANCE_ID, 'codex-personal')

    const resolved = sessionDefaultsFor('thread-claude-1', 'claude-code', {})
    expect(resolved.instanceId).toBeUndefined()
  })

  it('does not hand a Codex machine default to a brand-new OpenCode session', () => {
    rows.set('codex-personal', codexRow())
    settings.set(SETTING_DEFAULT_INSTANCE_ID, 'codex-personal')

    const resolved = sessionDefaultsFor('thread-opencode-1', 'opencode', {})
    expect(resolved.instanceId).toBeUndefined()
  })

  it('still honors the legacy global key for the agent that actually owns it (kanban/new-session/mobile all resolve through this)', () => {
    rows.set('codex-personal', codexRow())
    settings.set(SETTING_DEFAULT_INSTANCE_ID, 'codex-personal')

    const resolved = sessionDefaultsFor('thread-codex-1', 'codex', {})
    expect(resolved.instanceId).toBe('codex-personal')
  })

  it('prefers the scoped per-agent key over the legacy global key', () => {
    rows.set('codex-personal', codexRow())
    rows.set('claude-work', codexRow({ id: 'claude-work', agentType: 'claude-code', displayName: 'Work Claude' }))
    settings.set(SETTING_DEFAULT_INSTANCE_ID, 'codex-personal')
    settings.set(defaultInstanceSettingKey('claude-code'), 'claude-work')

    const resolved = sessionDefaultsFor('thread-claude-2', 'claude-code', {})
    expect(resolved.instanceId).toBe('claude-work')
  })

  it('leaves both tiers empty when nothing was ever set for this agent', () => {
    const resolved = sessionDefaultsFor('thread-fresh', 'opencode', {})
    expect(resolved.instanceId).toBeUndefined()
  })
})
