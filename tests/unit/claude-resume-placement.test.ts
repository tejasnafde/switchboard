import { describe, expect, it, vi } from 'vitest'
import { resolveResumePlacement } from '../../src/main/provider/adapters/claude-adapter'

const HELD = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'

const ok = { ok: true, copied: false } as const
const gone = { ok: false, reason: 'source-missing' } as const
const ioError = { ok: false, reason: 'io-error', detail: 'ENOSPC' } as const

describe('resolveResumePlacement', () => {
  it('keeps the held id when its transcript is in place', () => {
    const alternate = vi.fn()
    const result = resolveResumePlacement(HELD, () => ok, alternate)
    expect(result).toEqual({ sessionId: HELD, placed: ok, alternateIoErrorStreak: 0 })
    expect(alternate).not.toHaveBeenCalled()
  })

  it('recovers to a sibling when the held id has no transcript', () => {
    const result = resolveResumePlacement(
      HELD,
      (id) => (id === SIBLING ? ok : gone),
      () => SIBLING,
    )
    expect(result).toEqual({ sessionId: SIBLING, placed: ok, alternateIoErrorStreak: 0 })
  })

  it('does not re-resolve on a transient io-error of the held id itself', () => {
    const alternate = vi.fn()
    const result = resolveResumePlacement(HELD, () => ioError, alternate)
    expect(result.sessionId).toBe(HELD)
    expect(result.alternateIoErrorStreak).toBe(0)
    expect(alternate).not.toHaveBeenCalled()
  })

  it('keeps the held id when no sibling has a transcript either', () => {
    const result = resolveResumePlacement(HELD, () => gone, () => undefined)
    expect(result).toEqual({ sessionId: HELD, placed: gone, alternateIoErrorStreak: 0 })
  })

  it('keeps the held id when the sibling is also missing its transcript', () => {
    const result = resolveResumePlacement(HELD, () => gone, () => SIBLING)
    expect(result).toEqual({ sessionId: HELD, placed: gone, alternateIoErrorStreak: 0 })
  })

  it('does not re-run preflight when the alternate is the held id', () => {
    const probed: string[] = []
    const result = resolveResumePlacement(
      HELD,
      (id) => { probed.push(id); return gone },
      () => HELD,
    )
    expect(result).toEqual({ sessionId: HELD, placed: gone, alternateIoErrorStreak: 0 })
    expect(probed).toEqual([HELD])
  })

  describe('a sibling io-error', () => {
    const flaky = (id: string) => (id === SIBLING ? ioError : gone)

    it('reports the error and keeps the held id (never adopts an unverified alternate)', () => {
      const result = resolveResumePlacement(HELD, flaky, () => SIBLING)
      expect(result).toEqual({ sessionId: HELD, placed: ioError, alternateIoErrorStreak: 1 })
    })

    it('keeps retrying - without losing the original source-missing diagnosis - while under budget', () => {
      let streak = 0
      for (let turn = 0; turn < 2; turn++) {
        const result = resolveResumePlacement(HELD, flaky, () => SIBLING, streak)
        expect(result.sessionId).toBe(HELD)
        expect(result.placed).toEqual(ioError)
        streak = result.alternateIoErrorStreak
      }
      expect(streak).toBe(2)
    })

    it('gives up and surfaces the original source-missing diagnosis once the alternate error persists past the retry budget', () => {
      let streak = 0
      let result
      for (let turn = 0; turn < 10; turn++) {
        result = resolveResumePlacement(HELD, flaky, () => SIBLING, streak)
        streak = result.alternateIoErrorStreak
        if (streak === 0) break
      }
      expect(result).toEqual({ sessionId: HELD, placed: gone, alternateIoErrorStreak: 0 })
    })

    it('recovers once the alternate stops erroring, even mid-retry', () => {
      let calls = 0
      const recovers = (id: string) => {
        if (id !== SIBLING) return gone
        calls++
        return calls < 2 ? ioError : ok
      }
      let streak = 0
      let result = resolveResumePlacement(HELD, recovers, () => SIBLING, streak)
      expect(result).toEqual({ sessionId: HELD, placed: ioError, alternateIoErrorStreak: 1 })
      streak = result.alternateIoErrorStreak

      result = resolveResumePlacement(HELD, recovers, () => SIBLING, streak)
      expect(result).toEqual({ sessionId: SIBLING, placed: ok, alternateIoErrorStreak: 0 })
    })
  })
})
