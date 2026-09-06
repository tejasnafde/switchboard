/**
 * `SwitchboardClient.getSessionDefaults` prefills NewSessionScreen's mode/
 * model/profile from the machine's stored defaults. The instance id used to
 * come from one unscoped `chat.defaultProviderInstanceId` key - a Codex pick
 * on the desktop would prefill a brand-new Claude/OpenCode session on the
 * phone too. Per-agent scoping (see src/shared/session-defaults.ts) fixes
 * the write side on desktop; this covers the read side here, including
 * back-compat with a machine that only ever set the old global key.
 *
 * `setConversationProviderInstanceId` is the DB-only repoint the phone needs
 * for the same "no live session yet" case the desktop's ChatPanel already
 * handles (`context-unavailable` from `switchInstance`) - see
 * profileRotation.test.ts for the ThreadScreen-side wiring.
 */
import type { Transport } from '@shared/transport'
import { AppChannels, ProviderInstanceChannels } from '@shared/ipc-channels'
import { defaultInstanceSettingKey, SETTING_DEFAULT_INSTANCE_ID } from '@shared/session-defaults'
import { SwitchboardClient } from '../api'

function fakeTransport(handlers: Record<string, (...args: unknown[]) => unknown>): Transport {
  return {
    invoke: (jest.fn((channel: string, ...args: unknown[]) => {
      const handler = handlers[channel]
      if (!handler) throw new Error(`unmocked channel: ${channel}`)
      return Promise.resolve(handler(...args))
    }) as unknown) as Transport['invoke'],
    send: jest.fn(),
    on: jest.fn(() => () => {}),
  }
}

describe('SwitchboardClient.getSessionDefaults - instance id is agent-scoped', () => {
  it('does not prefill a Claude session with a Codex machine default stored under the legacy key', async () => {
    const transport = fakeTransport({
      'settings:get': (key) => {
        if (key === SETTING_DEFAULT_INSTANCE_ID) return 'codex-personal'
        return null
      },
      [ProviderInstanceChannels.LIST]: () => [
        { id: 'codex-personal', agentType: 'codex', displayName: 'Personal', accentColor: null, authMode: 'env', envKeys: [], oauthDir: null, effectiveOauthDir: null, enabled: true, createdAt: 0, updatedAt: 0 },
      ],
    })
    const client = new SwitchboardClient(transport)
    const defaults = await client.getSessionDefaults('claude-code')
    expect(defaults.instanceId).toBeUndefined()
  })

  it('honors the legacy key for the agent that actually owns the instance', async () => {
    const transport = fakeTransport({
      'settings:get': (key) => {
        if (key === SETTING_DEFAULT_INSTANCE_ID) return 'codex-personal'
        return null
      },
      [ProviderInstanceChannels.LIST]: () => [
        { id: 'codex-personal', agentType: 'codex', displayName: 'Personal', accentColor: null, authMode: 'env', envKeys: [], oauthDir: null, effectiveOauthDir: null, enabled: true, createdAt: 0, updatedAt: 0 },
      ],
    })
    const client = new SwitchboardClient(transport)
    const defaults = await client.getSessionDefaults('codex')
    expect(defaults.instanceId).toBe('codex-personal')
  })

  it('prefers the scoped per-agent key over the legacy global one', async () => {
    const transport = fakeTransport({
      'settings:get': (key) => {
        if (key === defaultInstanceSettingKey('claude-code')) return 'claude-work'
        if (key === SETTING_DEFAULT_INSTANCE_ID) return 'codex-personal'
        return null
      },
    })
    const client = new SwitchboardClient(transport)
    const defaults = await client.getSessionDefaults('claude-code')
    expect(defaults.instanceId).toBe('claude-work')
    // The scoped key alone was decisive - no need to even list instances.
    expect(transport.invoke).not.toHaveBeenCalledWith(expect.stringContaining('list'))
  })
})

describe('SwitchboardClient.setConversationProviderInstanceId', () => {
  it('invokes the same DB-only repoint channel the desktop client uses', async () => {
    const transport = fakeTransport({
      [AppChannels.SET_CONVERSATION_PROVIDER_INSTANCE_ID]: () => ({ ok: true }),
    })
    const client = new SwitchboardClient(transport)
    const result = await client.setConversationProviderInstanceId('conv-1', 'claude-work')
    expect(result).toEqual({ ok: true })
    expect(transport.invoke).toHaveBeenCalledWith(
      AppChannels.SET_CONVERSATION_PROVIDER_INSTANCE_ID,
      'conv-1',
      'claude-work',
    )
  })
})
