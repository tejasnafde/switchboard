import { createHash } from 'node:crypto'
import type {
  AcceptedUserTurnRecord,
  CanonicalUserTurnRow,
  TurnAcceptanceKey,
  TurnAcceptanceStore,
  TurnAcceptanceState,
} from '../db/turn-acceptance'
import type { SqliteTurnAcceptanceStore } from '../db/turn-acceptance'
import {
  canonicalUserTurnSubmission,
  echoMessageId,
  validateUserTurnSubmission,
  type RuntimeUserMessageEvent,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
} from '../../shared/provider-events'
import { generateTitle } from '../../shared/auto-title'
import { createMainLogger } from '../logger'

const log = createMainLogger('provider:turn-acceptance')

export type TurnAcceptanceResult =
  | { accepted: true; duplicate: boolean; state: 'completed'; reason?: string }
  | { accepted: false; duplicate: boolean; state: 'pending' | 'ambiguous'; reason?: string }

/** Only this error proves the provider did not accept the turn. */
export class TurnNotAcceptedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TurnNotAcceptedError'
  }
}

export class TurnOriginConflictError extends Error {
  constructor() {
    super('turn origin was already used with a different payload')
    this.name = 'TurnOriginConflictError'
  }
}

export class DurableTurnAcceptance {
  constructor(private readonly store: TurnAcceptanceStore) {}

  async accept(
    key: TurnAcceptanceKey,
    payloadHash: string,
    dispatch: () => Promise<void>,
  ): Promise<TurnAcceptanceResult> {
    const reservation = this.store.reserve(key, payloadHash)
    if (reservation.kind === 'conflict') throw new TurnOriginConflictError()
    if (reservation.kind === 'duplicate') return duplicateResult(reservation.state)

    if (!this.store.beginDispatch(key, payloadHash)) {
      const observed = this.store.reserve(key, payloadHash)
      if (observed.kind === 'conflict') throw new TurnOriginConflictError()
      if (observed.kind === 'reserved') {
        return { accepted: false, duplicate: true, state: 'pending' }
      }
      return duplicateResult(observed.state)
    }

    try {
      await dispatch()
    } catch (error) {
      if (error instanceof TurnNotAcceptedError) this.store.release(key, payloadHash)
      throw error
    }

    if (!this.store.complete(key, payloadHash)) {
      throw new Error('provider accepted turn but durable acceptance could not be completed')
    }
    return { accepted: true, duplicate: false, state: 'completed' }
  }
}

export interface AtomicUserTurnContext {
  clientScope: string
  conversationId?: string
  prepare: () => Promise<void>
  dispatch: () => Promise<void>
}

export class AtomicUserTurnSubmission {
  private readonly store: SqliteTurnAcceptanceStore
  private readonly publish: (event: RuntimeUserMessageEvent) => void
  private readonly now: () => number

  constructor(options: {
    store: SqliteTurnAcceptanceStore
    publish: (event: RuntimeUserMessageEvent) => void
    now?: () => number
  }) {
    this.store = options.store
    this.publish = options.publish
    this.now = options.now ?? Date.now
  }

  async submit(input: UserTurnSubmissionV1, context: AtomicUserTurnContext): Promise<UserTurnSubmissionResult> {
    let turn: UserTurnSubmissionV1
    let canonical: string
    try {
      turn = validateUserTurnSubmission(input)
      canonical = canonicalUserTurnSubmission(turn)
    } catch (error) {
      log.warn('rejected invalid user-turn envelope', error)
      return rejectedResult(error, false)
    }

    let key: TurnAcceptanceKey = {
      clientScope: context.clientScope,
      threadId: context.conversationId ?? turn.threadId,
      origin: turn.origin,
    }
    const payloadHash = createHash('sha256').update(canonical).digest('hex')
    const messageId = echoMessageId(turn.origin)
    const eventAt = this.now()
    const reservation = this.store.reserveEnvelope(key, payloadHash, canonical, messageId, eventAt)
    if (reservation.kind === 'conflict') {
      return {
        status: 'conflict',
        accepted: false,
        duplicate: true,
        state: 'conflict',
        reason: 'turn origin was already used with a different payload',
      }
    }
    if (reservation.kind === 'blocked') {
      return {
        status: 'rejected',
        accepted: false,
        duplicate: false,
        state: 'rejected',
        retryable: true,
        reason: `Earlier turn delivery is unresolved (${reservation.blockingOrigin})`,
      }
    }
    if (reservation.kind === 'duplicate') {
      if ('clientScope' in reservation) key = { ...key, clientScope: reservation.clientScope }
      if (reservation.state === 'completed') return this.replayCompleted(key)
      if (reservation.state === 'reserved') {
        return {
          status: 'pending',
          accepted: false,
          duplicate: true,
          state: 'pending',
          reason: 'Turn is reserved for provider dispatch',
        }
      }
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: true,
        state: 'ambiguous',
        reason: 'Provider delivery is unconfirmed; retry with the same origin only',
      }
    }

    try {
      await context.prepare()
    } catch (error) {
      log.warn(`turn preparation rejected for ${turn.threadId}`, error)
      this.store.release(key, payloadHash)
      return rejectedResult(error)
    }

    if (!this.store.beginDispatch(key, payloadHash)) {
      return {
        status: 'pending',
        accepted: false,
        duplicate: true,
        state: 'pending',
        reason: 'Turn could not enter provider dispatch',
      }
    }

    try {
      await context.dispatch()
    } catch (error) {
      if (error instanceof TurnNotAcceptedError) {
        log.warn(`provider definitely rejected turn ${turn.threadId}`, error)
        this.store.release(key, payloadHash)
        return rejectedResult(error)
      }
      log.warn(`provider delivery is ambiguous for ${turn.threadId}`, error)
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: false,
        state: 'ambiguous',
        reason: `Provider delivery is unconfirmed: ${errorMessage(error)}`,
      }
    }

    const acceptedAt = this.now()
    const record: AcceptedUserTurnRecord = {
      messageId,
      providerText: turn.providerText,
      imagesJson: turn.images ? JSON.stringify(turn.images) : undefined,
      displayBody: turn.displayBody,
      pillsMetaJson: turn.pillsMeta ? JSON.stringify(turn.pillsMeta) : undefined,
      acceptedAt,
      autoTitle: turn.autoTitleText ? generateTitle(turn.autoTitleText) : undefined,
      handoff: turn.handoff,
    }
    let completion: { completed: boolean; conversationTitle?: string }
    try {
      completion = this.store.completeUserTurn(key, payloadHash, record)
    } catch (error) {
      log.warn(`provider accepted turn but transcript commit failed for ${turn.threadId}`, error)
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: false,
        state: 'ambiguous',
        reason: `Provider accepted the turn but the durable transcript commit is unconfirmed: ${errorMessage(error)}`,
      }
    }
    if (!completion.completed) {
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: false,
        state: 'ambiguous',
        reason: 'Provider accepted the turn but the durable transcript commit is unconfirmed',
      }
    }
    const canonicalRow = this.store.readCanonicalUserTurn(key)
    if (!canonicalRow) {
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: false,
        state: 'ambiguous',
        reason: 'Provider accepted the turn but the canonical user event is unavailable',
      }
    }
    this.publish(canonicalEvent(key, canonicalRow))
    return {
      status: 'accepted',
      accepted: true,
      duplicate: false,
      state: 'completed',
      acceptedAt: canonicalRow.eventAt,
      ...(completion.conversationTitle ? { conversationTitle: completion.conversationTitle } : {}),
    }
  }

  private replayCompleted(key: TurnAcceptanceKey): UserTurnSubmissionResult {
    const row = this.store.readCanonicalUserTurn(key)
    if (!row) {
      return {
        status: 'ambiguous',
        accepted: false,
        duplicate: true,
        state: 'ambiguous',
        reason: 'Completed turn is missing its canonical transcript row',
      }
    }
    this.publish(canonicalEvent(key, row))
    return {
      status: 'accepted',
      accepted: true,
      duplicate: true,
      state: 'completed',
      acceptedAt: row.eventAt,
      ...(row.conversationTitle ? { conversationTitle: row.conversationTitle } : {}),
    }
  }
}

function canonicalEvent(key: TurnAcceptanceKey, row: CanonicalUserTurnRow): RuntimeUserMessageEvent {
  const envelope = parseJson<UserTurnSubmissionV1>(row.envelopeJson)
  return {
    type: 'user.message',
    threadId: key.threadId,
    text: row.providerText,
    displayBody: row.displayBody ?? undefined,
    pillsMeta: parseJson(row.pillsMetaJson),
    images: parseJson(row.imagesJson),
    origin: key.origin,
    at: row.eventAt,
    ...(row.conversationTitle ? { conversationTitle: row.conversationTitle } : {}),
    ...(envelope?.handoff ? {
      handoffMarker: { id: envelope.handoff.markerId, text: envelope.handoff.markerText },
    } : {}),
  }
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch (error) {
    log.warn('canonical user-turn metadata is corrupt', error)
    return undefined
  }
}

function rejectedResult(error: unknown, retryable = true): UserTurnSubmissionResult {
  return {
    status: 'rejected',
    accepted: false,
    duplicate: false,
    state: 'rejected',
    retryable,
    reason: errorMessage(error),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function duplicateResult(state: TurnAcceptanceState): TurnAcceptanceResult {
  if (state === 'completed') return { accepted: true, duplicate: true, state: 'completed' }
  if (state === 'reserved') return { accepted: false, duplicate: true, state: 'pending' }
  return { accepted: false, duplicate: true, state: 'ambiguous' }
}

export function turnPayloadHash(
  message: string,
  runtimeMode?: string,
  images?: Array<{ url: string; mimeType?: string }>,
): string {
  return createHash('sha256').update(JSON.stringify({
    message,
    runtimeMode: runtimeMode ?? null,
    images: images?.map((image) => ({ url: image.url, mimeType: image.mimeType ?? null })) ?? null,
  })).digest('hex')
}
