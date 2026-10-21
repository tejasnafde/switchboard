/**
 * Wire and work ceilings for opening a long chat: a window payload, an older
 * page and the SQLite rows read stay bounded however long the chat grows.
 * Raise a ceiling only with a measured reason.
 */
import { createMigratedDb } from './helpers/test-db'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')
const { clearMergedHistories } = await import('../../src/main/conversations/history')

const DESKTOP = { window: true, limit: 200, imageRefs: true, toolPreviews: true }
const PHONE = { window: true, limit: 200 }
const DESKTOP_WINDOW_BYTES = 400 * 1024
const PHONE_WINDOW_BYTES = 1024 * 1024 + 64 * 1024
const ROWS_READ = 1_000
const TURNS = 600

type Load = (
  id: string,
  opts: object,
) => Promise<{
  messages: Array<{ id: string }>
  nextBeforeId?: string | null
  total: number
}>

let load: Load
beforeAll(() => {
  const db = createMigratedDb()
  db.prepare("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')").run()
  db.prepare("INSERT INTO conversations (id, project_path, agent_type) VALUES ('long', '/repo', 'claude-code')").run()
  const insert = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, tool_calls, images, timestamp) VALUES (?, 'long', ?, ?, ?, ?, ?)",
  )
  const png = `data:image/png;base64,${Buffer.alloc(200_000).toString('base64')}`
  let at = Date.UTC(2026, 0, 1)
  db.transaction(() => {
    for (let turn = 0; turn < TURNS; turn++) {
      const images = turn % 25 === 0 ? JSON.stringify([{ url: png, mimeType: 'image/png' }]) : null
      insert.run(`u${turn}`, 'user', `prompt ${turn}`, null, images, (at += 60_000))
      for (let step = 0; step < 5; step++) {
        const call = {
          id: `t${turn}_${step}`,
          name: 'Bash',
          input: '{"command":"cat big.log"}',
          output: 'x'.repeat(30_000),
        }
        insert.run(`a${turn}_${step}`, 'assistant', '', JSON.stringify([call]), null, (at += 5_000))
      }
      insert.run(`r${turn}`, 'assistant', `reply ${turn}`, null, null, (at += 5_000))
    }
  })()
  clearMergedHistories()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerAppHandlers(
    { handle: (c: string, h: (...args: unknown[]) => unknown) => handlers.set(c, h), emit: () => {} } as never,
    {},
  )
  load = handlers.get(AppChannels.LOAD_SESSION_BY_ID) as Load
})

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

describe('long chat payload ceilings', () => {
  it('bounds the desktop newest window and an older page', async () => {
    const newest = await load('long', DESKTOP)
    expect(newest.messages).toHaveLength(200)
    expect(bytes(newest)).toBeLessThan(DESKTOP_WINDOW_BYTES)
    const older = await load('long', { ...DESKTOP, beforeId: newest.nextBeforeId })
    expect(older.messages.length).toBeGreaterThan(0)
    expect(bytes(older)).toBeLessThan(DESKTOP_WINDOW_BYTES)
  })

  it('caps a phone window by bytes and pages on from the first kept row', async () => {
    const newest = await load('long', PHONE)
    expect(bytes(newest)).toBeLessThan(PHONE_WINDOW_BYTES)
    expect(newest.nextBeforeId).toBe(newest.messages[0].id)
    const older = await load('long', { ...PHONE, beforeId: newest.nextBeforeId })
    expect(bytes(older)).toBeLessThan(PHONE_WINDOW_BYTES)
    expect(older.messages.at(-1)?.id).not.toBe(newest.messages[0].id)
  })

  it('reads a bounded number of rows per window', async () => {
    const { messageWindowRows } = await import('../../src/main/db/database')
    const { mergeHistoryWindow } = await import('../../src/main/conversations/history-window')
    const newest = mergeHistoryWindow([], messageWindowRows(['long']), { limit: 200 })
    expect(newest.rowsRead).toBeLessThan(ROWS_READ)
    const older = mergeHistoryWindow([], messageWindowRows(['long']), { limit: 200, beforeId: newest.nextBeforeId! })
    expect(older.rowsRead).toBeLessThan(ROWS_READ)
    expect(TURNS * 7).toBeGreaterThan(ROWS_READ * 4)
  })
})
