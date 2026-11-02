/**
 * The phones' Settle (`chat_settle_v1`): the backend advertises it, a phone's
 * scopes reach its channels, and the shared rules run the fixture native
 * Android's `ChatSettleFixturesTest` runs too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHAT_SETTLE_CAPABILITY,
  SETTLE_UNDO_MS,
  canSettleStatus,
  isSettleUndoFresh,
  settleBroadcastNotice,
  settledNoticeText,
} from '../../src/shared/chat-settle'
import { isChannelAllowed, PHONE_SCOPES } from '../../src/shared/device-auth'
import { AppChannels } from '../../src/shared/ipc-channels'
import { BACKEND_CAPABILITIES } from '../../src/shared/ws-protocol'

const cases = JSON.parse(readFileSync(join(__dirname, '../fixtures/chat-settle-cases.json'), 'utf8'))

describe('chat_settle_v1', () => {
  it('is advertised in the ready frame', () => {
    expect(BACKEND_CAPABILITIES).toContain(CHAT_SETTLE_CAPABILITY)
  })

  it.each([AppChannels.SETTLE_CONVERSATION, AppChannels.UNSETTLE_CONVERSATION, AppChannels.SNOOZE_CONVERSATION])(
    'lets a phone call %s',
    (channel) => {
      expect(isChannelAllowed(PHONE_SCOPES, channel)).toBe(true)
    },
  )
})

describe('shared settle fixture', () => {
  it('offers Undo for the same time', () => {
    expect(SETTLE_UNDO_MS).toBe(cases.undoMs)
  })

  it.each(cases.noticeText as { title: string; prNumber?: number; expect: string }[])(
    'notice text for $title, PR $prNumber',
    (c) => {
      expect(settledNoticeText(c.title, c.prNumber)).toBe(c.expect)
    },
  )

  it.each(
    cases.broadcastNotice as {
      name: string
      event: { settledAt: number | null; title?: string; prNumber?: number }
      expect: string | null
    }[],
  )('broadcast notice: $name', (c) => {
    expect(settleBroadcastNotice(c.event)).toBe(c.expect)
  })

  it.each(cases.undoFresh as { name: string; age: number; expect: boolean }[])('undo fresh: $name', (c) => {
    expect(isSettleUndoFresh(1_000_000, 1_000_000 + c.age)).toBe(c.expect)
  })

  it.each(cases.canSettle as { status: string | null; expect: boolean }[])('canSettle $status', (c) => {
    expect(canSettleStatus(c.status)).toBe(c.expect)
  })
})
