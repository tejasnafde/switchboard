import { describe, expect, it } from 'vitest'
import * as submissionModule from '../../src/renderer/services/desktopTurnSubmission'
import {
  acceptedDesktopUserMessage,
  pendingDesktopUserMessage,
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

  it('labels an unchanged ambiguous recovery as a safe retry', () => {
    const recoveryAction = (submissionModule as unknown as Record<string, unknown>)
      .desktopComposerRecoveryAction
    expect(typeof recoveryAction).toBe('function')

    expect((recoveryAction as (
      recoveryFingerprint: string,
      currentFingerprint: string,
      ambiguous: boolean,
    ) => string)('same', 'same', true)).toBe('retry-safe')
  })

  it('requires a warning before an edited ambiguous recovery becomes a new send', () => {
    const candidate = (submissionModule as unknown as Record<string, unknown>)
      .desktopComposerRecoveryAction
    expect(typeof candidate).toBe('function')
    const recoveryAction = candidate as (
        recoveryFingerprint: string,
        currentFingerprint: string,
        ambiguous: boolean,
    ) => string

    expect(recoveryAction('before', 'after', true)).toBe('send-with-warning')
    expect(recoveryAction('before', 'after', false)).toBe('send-with-discard-warning')
  })

  it('labels an unchanged definite failure as a retry', () => {
    expect(submissionModule.desktopComposerRecoveryAction('same', 'same', false)).toBe('retry')
  })

  it('warns before a newer draft discards an unrestored definite failure', () => {
    expect(submissionModule.desktopComposerRecoveryAction('before', 'after', false))
      .toBe('send-with-discard-warning')
  })

  it('does not warn when the definite failure was already restored and edited in place', () => {
    expect(submissionModule.desktopComposerRecoveryAction('before', 'after', false, true))
      .toBe('send')
  })

  it('treats a missing durable delivery row as safe to move past', () => {
    const allowsSend = (submissionModule as unknown as Record<string, unknown>)
      .desktopRecoveryResolutionAllowsSend
    expect(typeof allowsSend).toBe('function')
    expect((allowsSend as (status: string) => boolean)('not_found')).toBe(true)
    expect((allowsSend as (status: string) => boolean)('pending')).toBe(false)
  })

  it('retains prepared turns only while delivery is still genuinely ambiguous', () => {
    const retain = (submissionModule as unknown as Record<string, unknown>)
      .shouldRetainPreparedDesktopTurn
    expect(typeof retain).toBe('function')
    expect((retain as (delivery: string) => boolean)('ambiguous')).toBe(true)
    expect((retain as (delivery: string) => boolean)('pending')).toBe(true)
    expect((retain as (delivery: string) => boolean)('rejected')).toBe(false)
    expect((retain as (delivery: string) => boolean)('conflict')).toBe(false)
  })

  it('retains a prepared turn for authoritative recovery replay', () => {
    const registry = submissionModule.createDesktopPreparedTurnRegistry() as unknown as Record<string, unknown>
    expect(typeof registry.get).toBe('function')
    ;(registry.prepare as (value: UserTurnSubmissionV1) => UserTurnSubmissionV1)(turn)

    expect((registry.get as (threadId: string, origin: string) => UserTurnSubmissionV1 | undefined)(
      turn.threadId,
      turn.origin,
    )).toEqual(turn)
  })
})
