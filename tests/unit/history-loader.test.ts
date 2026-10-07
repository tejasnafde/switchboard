/** Desktop older-window loads apply only while their cursor is current, and a full load completes the history. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { ensureFullHistory, loadOlderHistory } from '../../src/renderer/services/history-loader'
import { historyWindow, type HistoryLoadOptions } from '../../src/shared/phone-history-window'
import type { ChatMessage } from '../../src/shared/types'

const rows = Array.from({ length: 450 }, (_, i) => ({ id: `m${i}`, role: 'user', content: `${i}`, timestamp: i })) as ChatMessage[]
const load = vi.fn(async (_id: string, opts?: HistoryLoadOptions) =>
  opts?.window ? historyWindow(rows, opts) : { messages: rows })
;(globalThis as { window?: unknown }).window = { api: { app: { loadSessionById: load } } }

function open() {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  useAgentStore.getState().addSession({ id: 's', type: 'claude-code', status: 'idle' })
  const newest = historyWindow(rows, { limit: 200 })
  useAgentStore.getState().setMessages('s', newest.messages, newest.nextBeforeId)
}
const session = () => useAgentStore.getState().sessions.find((s) => s.id === 's')!

describe('history loader', () => {
  beforeEach(() => {
    load.mockClear()
    open()
  })

  it('loads older windows up to the first row, then stops asking', async () => {
    await loadOlderHistory('s')
    await loadOlderHistory('s')
    expect(session().messages).toEqual(rows)
    expect(session().olderHistoryCursor).toBeNull()
    await loadOlderHistory('s')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('drops an older window whose cursor was replaced by a reload', async () => {
    let release!: () => void
    load.mockImplementationOnce(async (_id, opts) => {
      await new Promise<void>((resolve) => { release = resolve })
      return historyWindow(rows, opts!)
    })
    const pending = loadOlderHistory('s')
    await Promise.resolve()
    useAgentStore.getState().setMessages('s', rows.slice(-3), null)
    release()
    await pending
    expect(session().messages).toEqual(rows.slice(-3))
  })

  it('completes the history even when an older window lands during the full load', async () => {
    let release!: () => void
    load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { messages: rows }
    })
    const full = ensureFullHistory('s')
    await Promise.resolve()
    await loadOlderHistory('s')
    release()
    await full
    expect(session().messages).toEqual(rows)
    expect(session().olderHistoryCursor).toBeNull()
  })
})
