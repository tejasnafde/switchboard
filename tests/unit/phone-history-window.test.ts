import { describe, expect, it } from 'vitest'
import { mergeHistoryItems } from '../../apps/mobile/src/lib/thread-history'
import { historyWindow, shouldLoadPhoneHistory } from '../../src/shared/phone-history-window'
import type { ChatMessage } from '../../src/shared/types'

const messages = Array.from({ length: 6800 }, (_, i) => ({
  id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(12000),
  timestamp: i,
})) as ChatMessage[]

describe('phone history window', () => {
  it('sends a bounded tail and pages older rows without overlap', () => {
    const tail = historyWindow(messages, { limit: 200 })
    expect(tail.messages).toEqual(messages.slice(-200))
    expect(tail.nextBeforeId).toBe('m6600')
    const older = historyWindow(messages, { limit: 200, beforeId: tail.nextBeforeId! })
    expect(older.messages).toEqual(messages.slice(6400, 6600))
    expect(older.total).toBe(6800)
    expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThan(Buffer.byteLength(JSON.stringify(messages)) / 30)
  })
  it('finishes at the beginning and detects a removed cursor', () => {
    expect(historyWindow(messages, { beforeId: 'm3', limit: 200 }).nextBeforeId).toBeNull()
    const reset = historyWindow(messages, { beforeId: 'removed', limit: 200 })
    expect(reset.cursorReset).toBe(true)
    expect(reset.messages).toEqual(messages.slice(-200))
  })
  it('bounds invalid and excessive limits', () => {
    expect(historyWindow(messages, { limit: 0.5 }).messages).toHaveLength(1)
    expect(historyWindow(messages, { limit: Number.NaN }).messages).toHaveLength(200)
    expect(historyWindow(messages, { limit: 100000 }).messages).toHaveLength(200)
  })
})

it('loads only for a gap or missing history cache', () => {
  expect(shouldLoadPhoneHistory(true, false)).toBe(false)
  expect(shouldLoadPhoneHistory(true, true)).toBe(true)
  expect(shouldLoadPhoneHistory(false, false)).toBe(true)
})

it('keeps live rows received during loading and avoids history duplicates', () => {
  const history = [{ kind: 'text' as const, id: 'h-a', text: 'hello', stream: 'assistant', done: true }]
  const live = [{ kind: 'text' as const, id: 'm-a-assistant', text: 'hello world', stream: 'assistant', done: false }]
  expect(mergeHistoryItems(history, live)).toEqual(live)
})
