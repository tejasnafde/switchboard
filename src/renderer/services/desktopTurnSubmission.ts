import {
  validateUserTurnSubmission,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
} from '@shared/provider-events'

export type DesktopTurnSubmissionOutcome =
  | { accepted: true; delivery: 'accepted'; result: Extract<UserTurnSubmissionResult, { accepted: true }> }
  | {
      accepted: false
      delivery: 'rejected' | 'pending' | 'ambiguous' | 'conflict'
      error: string
      recoveryOrigin?: string
    }

export interface DesktopTurnSubmissionDependencies {
  startSession: () => Promise<void>
  submit: (turn: UserTurnSubmissionV1) => Promise<UserTurnSubmissionResult>
}

/**
 * The renderer validates the complete commit-bearing envelope, starts the
 * provider session, and then hands ownership to the backend. It performs no
 * transcript, title, activity, or handoff mutation itself.
 */
export async function submitDesktopUserTurn(
  input: UserTurnSubmissionV1,
  dependencies: DesktopTurnSubmissionDependencies,
): Promise<DesktopTurnSubmissionOutcome> {
  let turn: UserTurnSubmissionV1
  try {
    turn = validateUserTurnSubmission(input)
  } catch (error) {
    return { accepted: false, delivery: 'rejected', error: errorMessage(error) }
  }

  try {
    await dependencies.startSession()
  } catch (error) {
    return {
      accepted: false,
      delivery: 'rejected',
      error: `Failed to start session: ${errorMessage(error)}`,
    }
  }

  let result: UserTurnSubmissionResult
  try {
    result = await dependencies.submit(turn)
  } catch (error) {
    if (isMissingAtomicHandler(error)) {
      return {
        accepted: false,
        delivery: 'rejected',
        error: 'This backend must be updated before Desktop can send an atomic user turn.',
      }
    }
    return {
      accepted: false,
      delivery: 'ambiguous',
      error: `Delivery is unconfirmed. Retry this exact turn: ${errorMessage(error)}`,
      recoveryOrigin: turn.origin,
    }
  }

  if (result.status === 'accepted') {
    return { accepted: true, delivery: 'accepted', result }
  }
  if (result.status === 'ambiguous') {
    return { accepted: false, delivery: 'ambiguous', error: result.reason, recoveryOrigin: turn.origin }
  }
  if (result.status === 'pending') {
    return { accepted: false, delivery: 'pending', error: result.reason }
  }
  if (result.status === 'conflict') {
    return { accepted: false, delivery: 'conflict', error: result.reason }
  }
  return {
    accepted: false,
    delivery: 'rejected',
    error: result.reason,
    ...('blockingOrigin' in result && result.blockingOrigin
      ? { recoveryOrigin: result.blockingOrigin }
      : {}),
  }
}

export interface DesktopTurnAttemptRegistry {
  originFor(threadId: string, fingerprint: string): string
  matches(threadId: string, fingerprint: string, origin: string): boolean
  accept(threadId: string, origin: string): void
}

export function createDesktopTurnAttemptRegistry(
  createOrigin: () => string = () => `d${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): DesktopTurnAttemptRegistry {
  const attempts = new Map<string, Map<string, string>>()
  return {
    originFor(threadId, fingerprint) {
      let threadAttempts = attempts.get(threadId)
      if (!threadAttempts) {
        threadAttempts = new Map()
        attempts.set(threadId, threadAttempts)
      }
      const existing = threadAttempts.get(fingerprint)
      if (existing) return existing
      const origin = createOrigin()
      threadAttempts.set(fingerprint, origin)
      return origin
    },
    matches(threadId, fingerprint, origin) {
      return attempts.get(threadId)?.get(fingerprint) === origin
    },
    accept(threadId, origin) {
      const threadAttempts = attempts.get(threadId)
      if (!threadAttempts) return
      for (const [fingerprint, candidate] of threadAttempts) {
        if (candidate === origin) threadAttempts.delete(fingerprint)
      }
      if (threadAttempts.size === 0) attempts.delete(threadId)
    },
  }
}

export const desktopTurnAttempts = createDesktopTurnAttemptRegistry()

export interface DesktopPreparedTurnRegistry {
  prepare(turn: UserTurnSubmissionV1): UserTurnSubmissionV1
  accept(threadId: string, origin: string): void
}

export function createDesktopPreparedTurnRegistry(): DesktopPreparedTurnRegistry {
  const prepared = new Map<string, UserTurnSubmissionV1>()
  const key = (threadId: string, origin: string): string => `${threadId}\u0000${origin}`
  return {
    prepare(turn) {
      const id = key(turn.threadId, turn.origin)
      const existing = prepared.get(id)
      if (existing) return existing
      prepared.set(id, turn)
      return turn
    },
    accept(threadId, origin) {
      prepared.delete(key(threadId, origin))
    },
  }
}

export const desktopPreparedTurns = createDesktopPreparedTurnRegistry()

export async function submitProgrammaticTurn(
  text: string,
  send: (text: string) => Promise<{ accepted: true } | { accepted: false; error: string }>,
  recover: (text: string, error: string) => void,
): Promise<boolean> {
  try {
    const result = await send(text)
    if (result.accepted) return true
    recover(text, result.error)
  } catch (error) {
    recover(text, errorMessage(error))
  }
  return false
}

export function desktopComposerFingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingAtomicHandler(error: unknown): boolean {
  return /(?:no handler|handler.*not registered).*provider:submit-user-turn/i.test(errorMessage(error))
}
