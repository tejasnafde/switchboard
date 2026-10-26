/** A memory trim drops the oldest rows from the store, and the older-window path loads them again. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import {
  ensureFullHistory,
  forgetHistoryView,
  holdFullHistory,
  loadOlderHistory,
  reportHistoryView,
  trimHistoryToBudget,
} from '../../src/renderer/services/history-loader'
import type { HistoryMemoryBudget } from '../../src/renderer/services/history-memory-budget'
import { historyWindow, type HistoryLoadOptions } from '../../src/shared/phone-history-window'
import type { ChatMessage } from '../../src/shared/types'

const rows = Array.from({ length: 450 }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `${i}`,
  timestamp: i,
})) as ChatMessage[]
const load = vi.fn(async (_id: string, opts?: HistoryLoadOptions) =>
  opts?.window ? historyWindow(rows, opts) : { messages: rows },
)
;(globalThis as { window?: unknown }).window = { api: { app: { loadSessionById: load } } }

const budget: HistoryMemoryBudget = {
  maxMessages: 300,
  maxBytes: 100_000_000,
  targetShare: 0.5,
  minKept: 50,
  minKeptTurns: 1,
}
const session = () => useAgentStore.getState().sessions.find((s) => s.id === 's')!

describe('history memory trim', () => {
  beforeEach(() => {
    load.mockClear()
    useAgentStore.setState({ sessions: [], activeSessionId: null, pendingScrollToMessage: null })
    useAgentStore.getState().addSession({ id: 's', type: 'claude-code', status: 'idle' })
    useAgentStore.getState().setMessages('s', rows, null)
  })

  it('drops the oldest turns, flips the chat to having older history, and the older path restores them', async () => {
    expect(session().olderHistoryCursor).toBeNull()
    const dropped = trimHistoryToBudget('s', budget)
    expect(dropped).toBe(300)
    expect(session().messages).toEqual(rows.slice(300))
    expect(session().olderHistoryCursor).toBe('m300')

    await loadOlderHistory('s')
    expect(session().messages).toEqual(rows.slice(100))
    await loadOlderHistory('s')
    expect(session().messages).toEqual(rows)
    expect(session().olderHistoryCursor).toBeNull()
  })

  it('reloads every row for a full reader after a trim', async () => {
    trimHistoryToBudget('s', budget)
    expect(await ensureFullHistory('s')).toBe(true)
    expect(session().messages).toEqual(rows)
  })

  it('keeps every row while a full reader holds the chat', () => {
    const release = holdFullHistory('s')
    expect(trimHistoryToBudget('s', budget)).toBe(0)
    release()
    expect(trimHistoryToBudget('s', budget)).toBe(300)
  })

  it('never makes a row appended live the cursor, since a full read may not return its id', () => {
    useAgentStore.getState().setMessages('s', rows.slice(0, 300), null)
    for (const row of rows.slice(300)) {
      useAgentStore.getState().appendMessage('s', { ...row, id: `remote_${row.id}` })
    }
    expect(trimHistoryToBudget('s', budget)).toBe(298)
    expect(session().olderHistoryCursor).toBe('m298')
  })

  it('waits for a pending jump to a row', () => {
    useAgentStore.getState().requestScrollToMessage('s', 'm3')
    expect(trimHistoryToBudget('s', budget)).toBe(0)
  })

  it('waits while a view is scrolled up, and never drops a shown row', () => {
    const scrolledUp = Symbol('a')
    reportHistoryView('s', scrolledUp, { firstMessageId: 'm10', following: false })
    expect(trimHistoryToBudget('s', budget)).toBe(0)
    reportHistoryView('s', scrolledUp, { firstMessageId: 'm200', following: true })
    expect(trimHistoryToBudget('s', budget)).toBe(200)
    expect(session().messages[0].id).toBe('m200')
    forgetHistoryView('s', scrolledUp)
  })
})
