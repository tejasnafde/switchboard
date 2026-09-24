import { describe, expect, it } from 'vitest'
import { canSteer, waitsForIdle } from '@shared/turn-delivery'

describe('turn delivery', () => {
  it('steers into a busy Claude or Codex turn, queues only on request', () => {
    for (const p of ['claude-code', 'claude', 'codex']) {
      expect(canSteer(p)).toBe(true)
      expect(waitsForIdle(p, true, 'steer')).toBe(false)
      expect(waitsForIdle(p, true, 'queue')).toBe(true)
    }
  })
  it('always queues a busy OpenCode turn', () => {
    expect(canSteer('opencode')).toBe(false)
    expect(waitsForIdle('opencode', true, 'steer')).toBe(true)
  })
  it('never waits when nothing is running', () => {
    expect(waitsForIdle('opencode', false, 'queue')).toBe(false)
    expect(waitsForIdle('claude-code', false, 'queue')).toBe(false)
  })
})

import { canonicalUserTurnSubmission, validateUserTurnSubmission } from '@shared/provider-events'

describe('turn envelope delivery field', () => {
  const base = { version: 1 as const, threadId: 't', origin: 'o', providerText: 'hi' }
  it('leaves the fingerprint of a turn without it unchanged, so retries across the upgrade still match', () => {
    expect(canonicalUserTurnSubmission(base)).not.toContain('delivery')
    expect(canonicalUserTurnSubmission({ ...base, delivery: 'queue' })).toContain('"delivery":"queue"')
  })
  it('rejects an unknown delivery', () => {
    expect(() => validateUserTurnSubmission({ ...base, delivery: 'later' })).toThrow(/delivery/)
  })
})

import {
  followUpDelivery,
  parseFollowUpDefault,
  promoteUnavailableReason,
  releasesOutstandingTurn,
  sendAction,
  startsOwnProviderTurn,
} from '@shared/turn-delivery'

describe('follow-up default', () => {
  it('defaults to steer, the behaviour Enter always had', () => {
    expect(parseFollowUpDefault(null)).toBe('steer')
    expect(parseFollowUpDefault('nonsense')).toBe('steer')
    expect(parseFollowUpDefault('queue')).toBe('queue')
  })
  it('gives Enter the default and the second shortcut the other one', () => {
    expect(followUpDelivery('steer', false)).toBe('steer')
    expect(followUpDelivery('steer', true)).toBe('queue')
    expect(followUpDelivery('queue', false)).toBe('queue')
    expect(followUpDelivery('queue', true)).toBe('steer')
  })
})

describe('send button', () => {
  it('just sends while idle', () => {
    expect(sendAction('claude-code', false, 'queue')).toEqual({ label: 'Send', tooltip: 'Send (Enter)' })
  })
  it('does the default mid-turn and names both keys', () => {
    expect(sendAction('claude-code', true, 'steer')).toEqual({ label: 'Steer', tooltip: 'Steer (Enter) · Queue (⌥Enter)' })
    expect(sendAction('codex', true, 'queue')).toEqual({ label: 'Queue', tooltip: 'Queue (Enter) · Steer (⌥Enter)' })
  })
  it('always queues on OpenCode, and says why', () => {
    const action = sendAction('opencode', true, 'steer')
    expect(action.label).toBe('Queue')
    expect(action.tooltip).toMatch(/OpenCode cannot take a message mid-turn/)
  })
})

describe('queued turn accounting', () => {
  it('counts every send as a turn of its own except a Codex steer', () => {
    expect(startsOwnProviderTurn('codex', true, 'steer')).toBe(false)
    expect(startsOwnProviderTurn('codex', true, undefined)).toBe(false)
    expect(startsOwnProviderTurn('codex', true, 'queue')).toBe(true)
    expect(startsOwnProviderTurn('codex', false, undefined)).toBe(true)
    expect(startsOwnProviderTurn('claude', true, 'steer')).toBe(true)
  })
  it('releases a cancelled message everywhere, a promoted one only where a steer joins the turn', () => {
    for (const p of ['claude', 'codex', 'opencode']) expect(releasesOutstandingTurn(p, 'cancelled')).toBe(true)
    expect(releasesOutstandingTurn('codex', 'promoted')).toBe(true)
    expect(releasesOutstandingTurn('claude', 'promoted')).toBe(false)
  })
  it('explains why OpenCode cannot send a queued message now', () => {
    expect(promoteUnavailableReason('claude-code')).toBeNull()
    expect(promoteUnavailableReason('opencode')).toMatch(/OpenCode/)
  })
})

import { runningPlaceholder } from '@shared/turn-delivery'

describe('running placeholder', () => {
  it('names the Enter behaviour the user chose, and the other key', () => {
    expect(runningPlaceholder('claude-code', 'steer')).toBe('Steer the agent, or ⌥Enter to queue for after this turn…')
    expect(runningPlaceholder('codex', 'queue')).toBe('Queue a follow-up, or ⌥Enter to steer the agent now…')
    expect(runningPlaceholder('opencode', 'steer')).toBe('Queue a follow-up… it sends when this turn ends.')
  })
})
