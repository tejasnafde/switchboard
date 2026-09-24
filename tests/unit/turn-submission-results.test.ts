import { describe, expect, it } from 'vitest'
import {
  errorMessage,
  isDefiniteAdapterPreconditionFailure,
  legacyAcceptanceResult,
  rejectedAtomicTurn,
} from '../../src/main/provider/turn-submission-results'
import { TurnNotAcceptedError, TurnOriginConflictError } from '../../src/main/provider/durable-turn-acceptance'
import type { UserTurnSubmissionResult } from '@shared/provider-events'

describe('turn submission results', () => {
  it('rejectedAtomicTurn is a retryable rejection', () => {
    expect(rejectedAtomicTurn('nope')).toEqual({
      status: 'rejected', accepted: false, duplicate: false, state: 'rejected', retryable: true, reason: 'nope',
    })
  })

  it('errorMessage reads Error.message or stringifies', () => {
    expect(errorMessage(new Error('x'))).toBe('x')
    expect(errorMessage(42)).toBe('42')
  })

  it('isDefiniteAdapterPreconditionFailure matches only the known adapter wordings', () => {
    for (const m of ['Session t1 not found', 'Session t1 not found or not connected', 'No OpenCode ACP session: t1', 'OpenCode ACP session not initialized']) {
      expect(isDefiniteAdapterPreconditionFailure(new Error(m), 't1')).toBe(true)
    }
    expect(isDefiniteAdapterPreconditionFailure(new Error('Session t2 not found'), 't1')).toBe(false)
    expect(isDefiniteAdapterPreconditionFailure(new Error('boom'), 't1')).toBe(false)
  })

  it('legacyAcceptanceResult maps accepted, and throws for every other state', () => {
    const r = (x: object) => x as UserTurnSubmissionResult
    expect(legacyAcceptanceResult(r({ status: 'accepted', duplicate: true }))).toEqual({ accepted: true, duplicate: true, state: 'completed' })
    expect(() => legacyAcceptanceResult(r({ status: 'pending', reason: 'slow' }))).toThrow('Network delivery unconfirmed; retry with the same origin. slow')
    expect(() => legacyAcceptanceResult(r({ status: 'ambiguous' }))).toThrow(/^Network delivery unconfirmed; retry with the same origin\.$/)
    expect(() => legacyAcceptanceResult(r({ status: 'conflict' }))).toThrow(TurnOriginConflictError)
    expect(() => legacyAcceptanceResult(r({ status: 'rejected', reason: 'full' }))).toThrow(TurnNotAcceptedError)
  })
})
