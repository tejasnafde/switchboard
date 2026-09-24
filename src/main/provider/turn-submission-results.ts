import type { UserTurnSubmissionResult } from '@shared/provider-events'
import {
  TurnNotAcceptedError,
  TurnOriginConflictError,
  type TurnAcceptanceResult,
} from './durable-turn-acceptance'

export function rejectedAtomicTurn(reason: string): UserTurnSubmissionResult {
  return {
    status: 'rejected',
    accepted: false,
    duplicate: false,
    state: 'rejected',
    retryable: true,
    reason,
  }
}

export function isDefiniteAdapterPreconditionFailure(error: unknown, threadId: string): boolean {
  const message = errorMessage(error)
  return message === `Session ${threadId} not found`
    || message === `Session ${threadId} not found or not connected`
    || message === `No OpenCode ACP session: ${threadId}`
    || message === 'OpenCode ACP session not initialized'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function legacyAcceptanceResult(result: UserTurnSubmissionResult): TurnAcceptanceResult {
  if (result.status === 'accepted') {
    return { accepted: true, duplicate: result.duplicate, state: 'completed' }
  }
  if (result.status === 'pending' || result.status === 'ambiguous') {
    // v0.8.35 mobile typed this positional endpoint as Promise<void> and
    // discarded any resolved body as success. Reject with its retry-classified
    // network wording so it retains the exact origin instead of losing an
    // ambiguous turn. Current clients use SUBMIT_USER_TURN and receive the
    // structured state above directly.
    throw new Error(`Network delivery unconfirmed; retry with the same origin. ${result.reason ?? ''}`.trim())
  }
  if (result.status === 'conflict') throw new TurnOriginConflictError()
  throw new TurnNotAcceptedError(result.reason)
}
