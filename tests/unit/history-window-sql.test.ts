/** The SQLite window reads page a family's history exactly like the full read. */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { historyWindow } from '../../src/shared/phone-history-window'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { getMessagesForConversation, messageRowsToChatMessages, messageWindowRows } from '../../src/main/db/database'
import { mergeHistoryWindow } from '../../src/main/conversations/history-window'
import { syntheticChat } from './helpers/synthetic-chat'

const family = ['root', 'rotated']

function store(rows: ChatMessage[]) {
  const db = createMigratedDb()
  db.prepare("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')").run()
  for (const id of family) db.prepare("INSERT INTO conversations (id, project_path) VALUES (?, '/repo')").run(id)
  const insert = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, tool_calls, timestamp, display_body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  // Shuffled insert order, so storage order differs from time order; a few equal timestamps.
  rows.forEach((row, index) =>
    insert.run(
      row.id,
      family[index % 2],
      row.role,
      row.content,
      row.toolCalls ? JSON.stringify(row.toolCalls) : null,
      index % 11 === 0 && index > 0 ? rows[index - 1].timestamp : row.timestamp,
      row.displayBody ?? null,
    ),
  )
}

describe('messageWindowRows', () => {
  beforeEach(() => createMigratedDb())

  it('pages a two-conversation family like the full read', () => {
    const { disk, stored } = syntheticChat(11, 150)
    store([...stored].reverse())
    const full = mergeConversationMessages(
      disk,
      family.flatMap((id) => messageRowsToChatMessages(getMessagesForConversation(id))),
    )
    for (const limit of [3, 200]) {
      const rows = messageWindowRows(family)
      const windowed: ChatMessage[] = []
      let beforeId: string | undefined
      do {
        const window = mergeHistoryWindow(disk, rows, { limit, beforeId })
        windowed.unshift(...window.messages)
        beforeId = window.nextBeforeId ?? undefined
      } while (beforeId)
      const pages: ChatMessage[][] = []
      let cursor: string | undefined
      do {
        const page = historyWindow(full, { limit, beforeId: cursor })
        pages.unshift(page.messages)
        cursor = page.nextBeforeId ?? undefined
      } while (cursor)
      expect(windowed).toEqual(pages.flat())
    }
  })

  it('reads a bounded number of rows for the newest window of a long chat', () => {
    const { disk, stored } = syntheticChat(12, 1500)
    store(stored)
    const window = mergeHistoryWindow(disk, messageWindowRows(family), { limit: 200 })
    expect(window.messages).toHaveLength(200)
    expect(window.rowsRead).toBeLessThan(800)
    expect(stored.length).toBeGreaterThan(5000)
  })
})
