import { createHash } from 'node:crypto'
import type {
  TurnAcceptanceKey,
  TurnAcceptanceStore,
  TurnAcceptanceState,
} from '../db/turn-acceptance'

export type TurnAcceptanceResult =
  | { accepted: true; duplicate: boolean; state: 'completed'; reason?: string }
  | { accepted: false; duplicate: true; state: 'pending' | 'ambiguous'; reason?: string }

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
