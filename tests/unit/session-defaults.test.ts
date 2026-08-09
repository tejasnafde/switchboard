/**
 * What a session starts as when the client did not say.
 *
 * There was no "machine default" tier at all: `START_SESSION` fell straight
 * from the request to a hardcoded `'sandbox'`, and never consulted the
 * conversation row or the stored setting. So a chat opened from the phone came
 * up in sandbox with the default profile even when the desktop had it on full
 * access with a named one, and reopening a desktop chat from the phone silently
 * restarted it with different permissions than it had a moment earlier.
 *
 * The order matters more than any single tier. A request value must always win,
 * or a client can no longer choose; and the conversation's own stored value must
 * beat the machine default, or reopening a chat rewrites what the user set on it.
 */
import { describe, it, expect } from 'vitest'
import { resolveSessionDefaults } from '../../src/shared/session-defaults'

describe('resolveSessionDefaults', () => {
  it('uses the request when the client stated one', () => {
    const resolved = resolveSessionDefaults({
      requested: { runtimeMode: 'plan', model: 'opus', instanceId: 'claude-work' },
      conversation: { runtimeMode: 'full-access', model: 'sonnet', instanceId: 'claude-home' },
      machine: { runtimeMode: 'sandbox', model: 'haiku', instanceId: 'claude-default' },
    })
    expect(resolved).toEqual({ runtimeMode: 'plan', model: 'opus', instanceId: 'claude-work' })
  })

  it('falls back to what this conversation was last using', () => {
    const resolved = resolveSessionDefaults({
      requested: {},
      conversation: { runtimeMode: 'full-access', model: 'sonnet', instanceId: 'claude-home' },
      machine: { runtimeMode: 'sandbox', model: 'haiku', instanceId: 'claude-default' },
    })
    expect(resolved).toEqual({ runtimeMode: 'full-access', model: 'sonnet', instanceId: 'claude-home' })
  })

  it('falls back to the machine default for a conversation with no history', () => {
    const resolved = resolveSessionDefaults({
      requested: {},
      conversation: {},
      machine: { runtimeMode: 'full-access', model: 'sonnet', instanceId: 'claude-work' },
    })
    expect(resolved).toEqual({ runtimeMode: 'full-access', model: 'sonnet', instanceId: 'claude-work' })
  })

  it('lands on sandbox when nothing anywhere has an opinion', () => {
    // Sandbox, not full access: the safe end is the right place to fail to.
    const resolved = resolveSessionDefaults({ requested: {}, conversation: {}, machine: {} })
    expect(resolved.runtimeMode).toBe('sandbox')
    expect(resolved.model).toBeUndefined()
    expect(resolved.instanceId).toBeUndefined()
  })

  it('resolves each field on its own, not as a group', () => {
    // The phone sends a mode and no model. Taking the whole tier because one
    // field was present would discard the conversation's model.
    const resolved = resolveSessionDefaults({
      requested: { runtimeMode: 'plan' },
      conversation: { model: 'sonnet', instanceId: 'claude-home' },
      machine: { runtimeMode: 'full-access', model: 'haiku', instanceId: 'claude-default' },
    })
    expect(resolved).toEqual({ runtimeMode: 'plan', model: 'sonnet', instanceId: 'claude-home' })
  })

  it('treats an empty string as absent, because that is what a cleared field sends', () => {
    const resolved = resolveSessionDefaults({
      requested: { model: '', instanceId: '' },
      conversation: { model: 'sonnet', instanceId: 'claude-home' },
      machine: {},
    })
    expect(resolved.model).toBe('sonnet')
    expect(resolved.instanceId).toBe('claude-home')
  })

  it('ignores a runtime mode that is not one, rather than passing it to an adapter', () => {
    // This crosses a process boundary from a client we do not control.
    const resolved = resolveSessionDefaults({
      requested: { runtimeMode: 'god-mode' },
      conversation: { runtimeMode: 'plan' },
      machine: {},
    })
    expect(resolved.runtimeMode).toBe('plan')
  })
})
