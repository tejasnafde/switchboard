import { describe, expect, it } from 'vitest'
import { holdsWholeHistory, olderThan, prependOlder, rebaseOnNewest, shouldLoadOlder, turnIndexHolding, PREFETCH_OLDER_PX } from '../../src/renderer/services/history-window'
import { historyWindow } from '../../src/shared/phone-history-window'
import type { ChatMessage } from '../../src/shared/types'

const rows = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `${i}`, timestamp: i })) as ChatMessage[]

describe('desktop history window', () => {
  it('pages from the newest window back to the first row with no gap or repeat', () => {
    let window = historyWindow(rows, { limit: 200 })
    let shown = window.messages
    let cursor = window.nextBeforeId
    while (cursor) {
      window = historyWindow(rows, { limit: 200, beforeId: cursor })
      shown = prependOlder(shown, window.messages)
      cursor = window.nextBeforeId
    }
    expect(shown).toEqual(rows)
  })

  it('drops overlap and keeps the same array when nothing is new', () => {
    const current = rows.slice(10)
    expect(prependOlder(current, rows.slice(5, 12)).map((m) => m.id)).toEqual(rows.slice(5).map((m) => m.id))
    expect(prependOlder(current, rows.slice(10, 12))).toBe(current)
  })

  it('cuts a full history at the oldest shown row', () => {
    expect(olderThan(rows, 'm300')).toEqual(rows.slice(0, 300))
    expect(olderThan(rows, 'missing')).toBeNull()
  })

  it('loads older rows once, when there are any', () => {
    const state = { scrollTop: 0, firstVisibleTurn: 0, turnCount: 40, hasOlder: true, loading: false }
    expect(shouldLoadOlder(state)).toBe(true)
    expect(shouldLoadOlder({ ...state, hasOlder: false })).toBe(false)
    expect(shouldLoadOlder({ ...state, loading: true })).toBe(false)
  })

  it('prefetches within a generous distance of the top, before the top is reached', () => {
    const state = { firstVisibleTurn: 30, turnCount: 40, hasOlder: true, loading: false }
    expect(shouldLoadOlder({ ...state, scrollTop: PREFETCH_OLDER_PX })).toBe(true)
    expect(shouldLoadOlder({ ...state, scrollTop: PREFETCH_OLDER_PX + 1 })).toBe(false)
  })

  it('prefetches once the first turn in view is among the oldest quarter, however far down that is', () => {
    const state = { scrollTop: 50_000, turnCount: 40, hasOlder: true, loading: false }
    expect(shouldLoadOlder({ ...state, firstVisibleTurn: 9 })).toBe(true)
    expect(shouldLoadOlder({ ...state, firstVisibleTurn: 10 })).toBe(false)
    expect(shouldLoadOlder({ ...state, firstVisibleTurn: null })).toBe(false)
  })

  it('finds the turn holding the anchored row after rows are added above', () => {
    expect(turnIndexHolding([[rows[0], rows[1]], [rows[2]]], 'm1')).toBe(0)
    expect(turnIndexHolding([[rows[0]], [rows[1], rows[2]]], 'm2')).toBe(1)
    expect(turnIndexHolding([], 'm2')).toBe(-1)
  })

  it('treats a window or an image reference as not the whole history', () => {
    expect(holdsWholeHistory({ messages: rows })).toBe(true)
    expect(holdsWholeHistory({ messages: rows, olderHistoryCursor: 'm1' })).toBe(false)
    const ref = { ...rows[0], images: [{ url: '', ref: { messageId: 'm0', index: 0, bytes: 1 } }] }
    expect(holdsWholeHistory({ messages: [ref] })).toBe(false)
  })

  it('rebases on the newest window only when a shown row lines it up', () => {
    const live = { id: 'live', role: 'assistant', content: '', timestamp: 999 } as ChatMessage
    expect(rebaseOnNewest([rows[1], rows[2], live], [rows[0], rows[2]])).toEqual([rows[0], rows[2], live])
    expect(rebaseOnNewest([rows[1], live], [rows[0], rows[2]])).toBeNull()
  })
})
