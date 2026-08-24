import { describe, expect, it } from 'vitest'
import {
  acceptedDesktopUserMessage,
  pendingDesktopTurnDisposition,
  pendingDesktopUserMessage,
  resolvedDesktopTurnDeliveryState,
  type DesktopTurnSubmissionOutcome,
} from '../../src/renderer/services/desktopTurnSubmission'
import type { RuntimeUserMessageEvent, UserTurnSubmissionV1 } from '../../src/shared/provider-events'

const turn: UserTurnSubmissionV1 = {
  version: 1,
  threadId: 'thread-1',
  origin: 'origin-1',
  providerText: '<context>hidden</context>\n\nhello',
  displayBody: 'hello',
  pillsMeta: {},
  images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'one.png' }],
  runtimeMode: 'sandbox',
}

describe('Desktop pending user-turn presentation', () => {
  it('uses the canonical echo id but does not claim backend acceptance', () => {
    expect(pendingDesktopUserMessage(turn, 123)).toEqual({
      id: 'remote_origin-1',
      role: 'user',
      content: turn.providerText,
      displayBody: 'hello',
      pillsMeta: {},
      images: turn.images,
      timestamp: 123,
      deliveryState: 'pending',
    })
  })

  it('turns the canonical echo into an accepted message with no transient state', () => {
    const event: RuntimeUserMessageEvent = {
      type: 'user.message',
      threadId: 'thread-1',
      origin: 'origin-1',
      text: turn.providerText,
      displayBody: turn.displayBody,
      pillsMeta: turn.pillsMeta,
      images: turn.images,
      at: 456,
    }

    expect(acceptedDesktopUserMessage(event)).toEqual({
      id: 'remote_origin-1',
      role: 'user',
      content: turn.providerText,
      displayBody: 'hello',
      pillsMeta: {},
      images: turn.images,
      timestamp: 456,
    })
  })

  it.each([
    [{ accepted: true, delivery: 'accepted', result: { status: 'accepted', accepted: true, duplicate: false, state: 'completed', acceptedAt: 1 } }, 'accepted'],
    [{ accepted: false, delivery: 'rejected', error: 'not started' }, 'remove'],
    [{ accepted: false, delivery: 'conflict', error: 'origin conflict' }, 'remove'],
    [{ accepted: false, delivery: 'pending', error: 'still reserved' }, 'unconfirmed'],
    [{ accepted: false, delivery: 'ambiguous', error: 'transport lost', recoveryOrigin: 'origin-1' }, 'unconfirmed'],
  ] as Array<[DesktopTurnSubmissionOutcome, 'accepted' | 'remove' | 'unconfirmed']>)(
    'maps %s without presenting a rejection as sent',
    (outcome, expected) => {
      expect(pendingDesktopTurnDisposition(outcome)).toBe(expected)
    },
  )

  it('distinguishes terminal abandonment from a completed canonical turn', () => {
    expect(resolvedDesktopTurnDeliveryState('abandoned')).toBe('abandoned')
    expect(resolvedDesktopTurnDeliveryState('completed')).toBeUndefined()
  })
})
