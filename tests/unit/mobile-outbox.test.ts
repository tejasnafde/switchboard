/**
 * The send queue's decisions.
 *
 * These matter because the outbox is the ONLY send path, not a fallback. Every
 * message the user commits to passes through them, so a wrong answer here is
 * either a lost message or a duplicated one, and both are worse than any
 * failure the queue exists to absorb.
 */
import { describe, it, expect } from 'vitest'
import {
  acceptanceDisposition,
  decodeTurnAcceptance,
  deliveryAction,
  deliveryFailureDisposition,
  freezePreparedTurn,
  outboxPresentation,
  markRejected,
  nextDeliverablePerThread,
  parseQueuedMessage,
  removeAcceptedOrigin,
  recoverRejectedDraft,
  selectRejectedForEdit,
  retryDelayMs,
  shouldRetry,
  MAX_RETRY_DELAY_MS,
  type QueuedMessage,
} from '../../apps/mobile/src/lib/outboxModel'
import { TurnDeduper } from '../../src/shared/turn-dedupe'

const base = {
  connected: true,
  threadBusy: false,
  threadExists: true,
  editing: false,
  nowMs: 1_000,
  retryNotBeforeMs: 0,
}

describe('deliveryAction', () => {
  it('sends when the backend is up and the thread is free', () => {
    expect(deliveryAction(base)).toBe('send')
  })

  it('waits while offline rather than failing the message', () => {
    expect(deliveryAction({ ...base, connected: false })).toBe('wait')
  })

  it('waits while the provider cannot take a mid-turn message', () => {
    expect(deliveryAction({ ...base, threadBusy: true })).toBe('wait')
  })

  it('waits while the user has the message open for editing', () => {
    // Delivering here would send a payload the user is still changing.
    expect(deliveryAction({ ...base, editing: true })).toBe('wait')
  })

  it('waits until the backoff has elapsed', () => {
    expect(deliveryAction({ ...base, nowMs: 1_000, retryNotBeforeMs: 5_000 })).toBe('wait')
    expect(deliveryAction({ ...base, nowMs: 5_000, retryNotBeforeMs: 5_000 })).toBe('send')
  })

  it('drops a message whose thread is gone, which no retry can fix', () => {
    expect(deliveryAction({ ...base, threadExists: false })).toBe('drop')
  })

  it('prefers dropping over sending when the thread is gone, whatever else is true', () => {
    expect(deliveryAction({ ...base, threadExists: false, connected: false, editing: true })).toBe('drop')
  })
})

describe('retryDelayMs', () => {
  it('backs off from one second and caps', () => {
    expect(retryDelayMs(1)).toBe(1_000)
    expect(retryDelayMs(2)).toBe(2_000)
    expect(retryDelayMs(3)).toBe(4_000)
    expect(retryDelayMs(99)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('never returns a negative or zero delay for a first attempt', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0)
  })
})

describe('shouldRetry', () => {
  it('retries a transport failure, which says nothing about the message', () => {
    expect(shouldRetry(new Error('WebSocket closed'))).toBe(true)
    expect(shouldRetry(new Error('invoke timed out: provider:send-turn'))).toBe(true)
    expect(shouldRetry(new Error('transport queue full: provider:send-turn'))).toBe(true)
  })

  it('gives up when the backend understood and refused', () => {
    // Repeating a refusal burns the battery against a wall and hides the
    // reason from the user. Retrying everything forever is the more common
    // mistake and the harder one to notice.
    expect(shouldRetry(new Error('No session: thread-1'))).toBe(false)
    expect(shouldRetry(new Error('no handler: provider:send-turn'))).toBe(false)
  })
})

describe('deliveryFailureDisposition', () => {
  it('retries cleanup without reporting a delivered provider turn as rejected', () => {
    expect(deliveryFailureDisposition(true, new Error('database is read-only'))).toBe('cleanup-retry')
  })

  it('retains normal retry classification before provider acceptance', () => {
    expect(deliveryFailureDisposition(false, new Error('WebSocket closed'))).toBe('retry')
    expect(deliveryFailureDisposition(false, new Error('No session'))).toBe('reject')
  })
})

describe('atomic acceptance results', () => {
  it('keeps pending and ambiguous acknowledgements in the outbox', () => {
    expect(acceptanceDisposition({ accepted: false, duplicate: true, state: 'pending' })).toBe('pending')
    expect(acceptanceDisposition({ accepted: false, duplicate: true, state: 'ambiguous' })).toBe('ambiguous')
    expect(acceptanceDisposition({ status: 'pending', accepted: false, state: 'pending' })).toBe('pending')
    expect(acceptanceDisposition({ status: 'ambiguous', accepted: false, state: 'ambiguous' })).toBe('ambiguous')
  })

  it('accepts completed results and old backends that returned no body', () => {
    expect(acceptanceDisposition({ accepted: true, duplicate: false, state: 'completed' })).toBe('accepted')
    expect(acceptanceDisposition({ accepted: true, duplicate: true, state: 'completed' })).toBe('accepted')
    expect(acceptanceDisposition({ status: 'accepted', accepted: true, state: 'completed' })).toBe('accepted')
    expect(acceptanceDisposition(undefined)).toBe('accepted')
  })

  it('preserves typed definite rejections and conflicts for editing', () => {
    expect(acceptanceDisposition({ status: 'rejected', retryable: false, reason: 'too large' })).toBe('rejected')
    expect(acceptanceDisposition({ status: 'conflict', reason: 'origin changed' })).toBe('conflict')
    expect(decodeTurnAcceptance({
      status: 'rejected',
      accepted: false,
      state: 'rejected',
      duplicate: false,
      retryable: true,
      reason: 'provider starting',
    })).toEqual({ disposition: 'rejected', retryable: true, reason: 'provider starting' })
    expect(decodeTurnAcceptance({
      status: 'conflict',
      accepted: false,
      state: 'conflict',
      duplicate: true,
      reason: 'origin changed',
    })).toEqual({ disposition: 'conflict', retryable: false, reason: 'origin changed' })
  })
})

describe('stable retry payload', () => {
  const message: QueuedMessage = {
    connectionId: 'mac',
    threadId: 'thread',
    messageId: 'turn-1',
    text: 'continue',
    images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    runtimeMode: 'sandbox',
    createdAt: 1,
    attempts: 0,
  }

  it('freezes the first handoff-expanded provider payload', () => {
    const first = freezePreparedTurn(message, {
      pending: true,
      wireMessage: 'handoff history\n\ncontinue',
    })
    const retry = freezePreparedTurn(first, {
      pending: false,
      wireMessage: 'continue',
    })

    expect(retry.providerText).toBe('handoff history\n\ncontinue')
    expect(retry.pendingHandoff).toBe(true)
    expect(retry.images).toEqual(message.images)
  })

  it('restores the frozen payload after serialization', () => {
    const prepared = freezePreparedTurn(message, {
      pending: true,
      wireMessage: 'handoff history\n\ncontinue',
    })
    expect(parseQueuedMessage(JSON.parse(JSON.stringify(prepared)))).toEqual(prepared)
  })
})

describe('canonical acceptance reconciliation', () => {
  const queued = (messageId: string, threadId = 'thread'): QueuedMessage => ({
    connectionId: 'mac',
    threadId,
    messageId,
    text: messageId,
    createdAt: 1,
    attempts: 0,
  })

  it('removes only the queued record proven accepted by its origin', () => {
    const result = removeAcceptedOrigin(
      [queued('accepted'), queued('other'), { ...queued('accepted', 'other-thread') }],
      'mac',
      'thread',
      'accepted',
    )

    expect(result.accepted?.messageId).toBe('accepted')
    expect(result.remaining.map((message) => `${message.threadId}:${message.messageId}`)).toEqual([
      'thread:other',
      'other-thread:accepted',
    ])
  })

  it('does nothing for another client origin', () => {
    const messages = [queued('mine')]
    expect(removeAcceptedOrigin(messages, 'mac', 'thread', 'theirs')).toEqual({
      accepted: undefined,
      remaining: messages,
    })
  })
})

describe('deterministic rejection recovery', () => {
  const image = { url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
  const message: QueuedMessage = {
    connectionId: 'mac',
    threadId: 'thread',
    messageId: 'turn-1',
    text: 'inspect this',
    images: [image],
    runtimeMode: 'sandbox',
    createdAt: 1,
    attempts: 0,
  }

  it('preserves the complete queued turn as a blocked editable record', () => {
    expect(markRejected(message, new Error('Images exceed the 3 MiB synchronization limit'))).toEqual({
      ...message,
      blockedReason: 'Images exceed the 3 MiB synchronization limit',
    })
  })

  it('restores the blocked reason with the turn after a process restart', () => {
    const blocked = markRejected(message, new Error('Unsupported image type'))
    expect(parseQueuedMessage(JSON.parse(JSON.stringify(blocked)))).toEqual(blocked)
  })

  it('does not let a blocked turn prevent a later valid turn from sending', () => {
    const blocked = markRejected(message, new Error('Unsupported image type'))
    const later = { ...message, messageId: 'turn-2', text: 'continue', images: undefined }
    expect(nextDeliverablePerThread([blocked, later])).toEqual([later])
  })

  it('distinguishes queued, ambiguous, and definitely failed records', () => {
    expect(outboxPresentation(message)).toEqual({ state: 'queued', label: 'Waiting to send' })
    expect(outboxPresentation({ ...message, deliveryState: 'ambiguous' })).toEqual({
      state: 'ambiguous',
      label: 'Delivery unconfirmed',
    })
    expect(outboxPresentation(markRejected(message, new Error('Unsupported image type')))).toEqual({
      state: 'failed',
      label: 'Not sent - Unsupported image type',
    })
  })

  it('recovers rejected text and image data URLs for editing', () => {
    const blocked = markRejected(message, new Error('Unsupported image type'))
    expect(recoverRejectedDraft(blocked)).toEqual({
      text: 'inspect this',
      images: [{
        id: 'recovered-turn-1-0',
        previewUri: image.url,
        url: image.url,
        mimeType: 'image/png',
      }],
    })
    expect(recoverRejectedDraft(message)).toBeNull()
  })

  it('keeps rejected attachments durable while the composer edits a copy', () => {
    const blocked = markRejected(message, new Error('Unsupported image type'))
    const messages = [blocked]

    expect(selectRejectedForEdit(messages, blocked.messageId)).toEqual(blocked)
    expect(messages).toEqual([blocked])
    expect(messages[0].images).toEqual([image])
  })
})

describe('TurnDeduper', () => {
  it('accepts an origin once and refuses it after', () => {
    const d = new TurnDeduper()
    expect(d.isDuplicate('turn-1')).toBe(false)
    expect(d.isDuplicate('turn-1')).toBe(true)
  })

  it('treats a missing origin as always new', () => {
    // Older clients send none. Collapsing them all onto one key would drop
    // every message after the first.
    const d = new TurnDeduper()
    expect(d.isDuplicate(undefined)).toBe(false)
    expect(d.isDuplicate(undefined)).toBe(false)
  })

  it('forgets an origin older than the window', () => {
    const d = new TurnDeduper(1_000)
    expect(d.isDuplicate('turn-1', 0)).toBe(false)
    expect(d.isDuplicate('turn-1', 500)).toBe(true)
    // Past the window nothing can still be in flight, so holding it is a leak.
    expect(d.isDuplicate('turn-1', 2_000)).toBe(false)
  })

  it('stays bounded on a long-running backend', () => {
    const d = new TurnDeduper(60_000, 10)
    for (let i = 0; i < 100; i++) d.isDuplicate(`turn-${i}`, 1)
    expect(d.size).toBeLessThanOrEqual(10)
  })

  it('keeps the most recent origins when it evicts', () => {
    const d = new TurnDeduper(60_000, 2)
    d.isDuplicate('a', 1)
    d.isDuplicate('b', 2)
    d.isDuplicate('c', 3)
    // 'a' fell out, so a late retry of it would run again. That is the cost of
    // the bound, and why the bound is far larger than any real retry window.
    expect(d.isDuplicate('c', 4)).toBe(true)
    expect(d.isDuplicate('b', 4)).toBe(true)
  })
})
