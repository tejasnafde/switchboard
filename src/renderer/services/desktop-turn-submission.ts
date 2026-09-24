import {
  echoMessageId,
  validateUserTurnSubmission,
  visibleUserMessageText,
  type RuntimeUserMessageEvent,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
} from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'

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

export function pendingDesktopUserMessage(
  turn: UserTurnSubmissionV1,
  timestamp: number = Date.now(),
): ChatMessage {
  return {
    id: echoMessageId(turn.origin),
    role: 'user',
    content: turn.providerText,
    displayBody: turn.displayBody,
    pillsMeta: turn.pillsMeta,
    images: turn.images,
    timestamp,
    deliveryState: 'pending',
  }
}

export function acceptedDesktopUserMessage(event: RuntimeUserMessageEvent): ChatMessage | null {
  const visibleText = visibleUserMessageText(event.text, event.displayBody)
  if (visibleText === null) return null
  return {
    id: echoMessageId(event.origin ?? String(event.at)),
    role: 'user',
    content: event.text,
    displayBody: visibleText === event.text ? undefined : visibleText,
    pillsMeta: event.pillsMeta,
    images: event.images,
    timestamp: event.at,
  }
}

export type DesktopComposerRecoveryAction =
  | 'retry-safe'
  | 'retry'
  | 'send-with-warning'
  | 'send-with-discard-warning'
  | 'send'

export function desktopComposerRecoveryAction(
  recoveryFingerprint: string,
  currentFingerprint: string,
  ambiguous: boolean,
  restored: boolean = false,
): DesktopComposerRecoveryAction {
  if (recoveryFingerprint === currentFingerprint) {
    return ambiguous ? 'retry-safe' : 'retry'
  }
  if (ambiguous) return 'send-with-warning'
  return restored ? 'send' : 'send-with-discard-warning'
}

export function desktopRecoveryResolutionAllowsSend(status: string): boolean {
  return status === 'abandoned' || status === 'completed' || status === 'not_found'
}

export function shouldRetainPreparedDesktopTurn(delivery: string): boolean {
  return delivery === 'pending' || delivery === 'ambiguous'
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
  get(threadId: string, origin: string): UserTurnSubmissionV1 | undefined
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
    get(threadId, origin) {
      return prepared.get(key(threadId, origin))
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
