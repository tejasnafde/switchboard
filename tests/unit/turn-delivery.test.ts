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
