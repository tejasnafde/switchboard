/** A window merged from nearby rows equals the same window cut from the full merge, page by page. */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { historyWindow } from '../../src/shared/phone-history-window'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { mergeHistoryWindow, type WindowRows } from '../../src/main/conversations/history-window'
import { syntheticChat } from './helpers/synthetic-chat'

/** Rows in the full read's order: by time, then insertion. */
function memoryRows(stored: ChatMessage[]): WindowRows & { reads: number } {
  const rows = [...stored].sort((a, b) => a.timestamp - b.timestamp)
  const out = {
    reads: 0,
    newestTimestamps: (at: number, count: number) =>
      rows
        .filter((row) => row.timestamp <= at)
        .map((row) => row.timestamp)
        .sort((a, b) => b - a)
        .slice(0, count),
    userTimestampsBefore: (at: number, count: number) =>
      rows
        .filter((row) => row.role === 'user' && row.timestamp <= at)
        .map((row) => row.timestamp)
        .sort((a, b) => b - a)
        .slice(0, count),
    userTimestampsAfter: (at: number, count: number) =>
      rows
        .filter((row) => row.role === 'user' && row.timestamp > at)
        .map((row) => row.timestamp)
        .slice(0, count),
    read: (from: number, to: number, ids: readonly string[]) => {
      const wanted = new Set(ids)
      const picked = rows.filter((row) => (row.timestamp >= from && row.timestamp <= to) || wanted.has(row.id))
      out.reads += picked.length
      return picked
    },
    timestampOf: (id: string) => rows.find((row) => row.id === id)?.timestamp,
    hasRowBefore: (at: number) => rows.some((row) => row.timestamp < at),
    count: () => rows.length,
  }
  return out
}

function fullPages(merged: ChatMessage[], limit: number): ChatMessage[][] {
  const pages: ChatMessage[][] = []
  let beforeId: string | undefined
  do {
    const page = historyWindow(merged, { limit, beforeId })
    pages.push(page.messages)
    beforeId = page.nextBeforeId ?? undefined
  } while (beforeId)
  return pages
}

describe('mergeHistoryWindow', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    for (const limit of [1, 7, 50, 200]) {
      it(`pages like the full merge (seed ${seed}, limit ${limit})`, () => {
        const { disk, stored } = syntheticChat(seed, 120)
        const merged = mergeConversationMessages(
          disk,
          [...stored].sort((a, b) => a.timestamp - b.timestamp),
        )
        const rows = memoryRows(stored)
        const windowed: ChatMessage[] = []
        let beforeId: string | undefined
        for (let page = 0; page < 10_000; page++) {
          const window = mergeHistoryWindow(disk, rows, { limit, beforeId })
          expect(window.cursorReset).toBe(false)
          windowed.unshift(...window.messages)
          if (!window.nextBeforeId) break
          beforeId = window.nextBeforeId
        }
        expect(windowed).toEqual(fullPages(merged, limit).reverse().flat())
      })
    }
  }

  for (const [name, keep] of [
    ['no transcript', 0],
    ['a short transcript', 30],
  ] as const) {
    it(`pages like the full merge with ${name}`, () => {
      const chat = syntheticChat(7, 80)
      const disk = keep === 0 ? [] : chat.disk.slice(-keep)
      const merged = mergeConversationMessages(
        disk,
        [...chat.stored].sort((a, b) => a.timestamp - b.timestamp),
      )
      const rows = memoryRows(chat.stored)
      for (const limit of [1, 50]) {
        const windowed: ChatMessage[] = []
        let beforeId: string | undefined
        do {
          const window = mergeHistoryWindow(disk, rows, { limit, beforeId })
          windowed.unshift(...window.messages)
          beforeId = window.nextBeforeId ?? undefined
        } while (beforeId)
        expect(windowed).toEqual(fullPages(merged, limit).reverse().flat())
      }
    })
  }

  it('reads only the rows near the newest window', () => {
    const { disk, stored } = syntheticChat(9, 2000)
    const rows = memoryRows(stored)
    const window = mergeHistoryWindow(disk, rows, { limit: 200 })
    expect(window.messages.length).toBe(200)
    expect(rows.reads).toBeLessThan(stored.length / 4)
  })

  it('finds one message through its id', () => {
    const { disk, stored } = syntheticChat(3, 300)
    const merged = mergeConversationMessages(
      disk,
      [...stored].sort((a, b) => a.timestamp - b.timestamp),
    )
    const target = merged[500]
    expect(mergeHistoryWindow(disk, memoryRows(stored), { throughId: target.id }).messages).toEqual([target])
  })

  it('answers a cursor it cannot find with the newest window', () => {
    const { disk, stored } = syntheticChat(3, 50)
    const window = mergeHistoryWindow(disk, memoryRows(stored), { limit: 20, beforeId: 'gone' })
    expect(window.cursorReset).toBe(true)
    expect(window.messages.at(-1)?.id).toBe(
      mergeHistoryWindow(disk, memoryRows(stored), { limit: 20 }).messages.at(-1)?.id,
    )
  })

  it('pages through messages that share a timestamp with the cursor', () => {
    const disk: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'q', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'r1', timestamp: 2 },
      ...[2, 3, 4, 5].map((n) => ({ id: `a${n}`, role: 'assistant' as const, content: `r${n}`, timestamp: 3 })),
    ]
    for (const limit of [1, 3]) {
      const seen: string[] = []
      let beforeId: string | undefined
      do {
        const page = mergeHistoryWindow(disk, memoryRows([]), { limit, beforeId })
        expect(page.messages.length).toBeGreaterThan(0)
        seen.unshift(...page.messages.map((message) => message.id))
        beforeId = page.nextBeforeId ?? undefined
      } while (beforeId)
      expect(seen).toEqual(['u1', 'a1', 'a2', 'a3', 'a4', 'a5'])
    }
  })
})
