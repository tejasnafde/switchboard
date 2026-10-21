/** A window read through the transcript index equals the same window cut from the full merged history. */
import { createMigratedDb } from './helpers/test-db'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
const { clearMergedHistories, loadConversationHistory, loadConversationHistoryWindow } =
  await import('../../src/main/conversations/history')
const { clearJsonlCache } = await import('../../src/main/agent/jsonl-cache')
const { clearTranscriptIndexMemory } = await import('../../src/main/agent/transcript-index')
const { historyWindow } = await import('../../src/shared/phone-history-window')

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001'
const projectDir = join(homedir(), '.claude', 'projects', '-repo-indexed')
const path = join(projectDir, `${SESSION}.jsonl`)
afterAll(() => rmSync(projectDir, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 0, 1)
function writeTranscript(turns: number): void {
  const lines: string[] = []
  for (let turn = 0; turn < turns; turn++) {
    const at = T0 + turn * 60_000
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${turn}`,
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: `prompt ${turn}` },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: `a${turn}`,
        timestamp: new Date(at + 1000).toISOString(),
        message: { content: [{ type: 'text', text: `reply ${turn} ${'y'.repeat(2000)}` }] },
      }),
    )
  }
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path, lines.join('\n') + '\n')
}

async function fresh(): Promise<void> {
  await clearTranscriptIndexMemory()
  clearJsonlCache()
  clearMergedHistories()
}

describe('indexed history window', () => {
  const db = createMigratedDb()
  db.exec("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')")
  db.prepare("INSERT INTO conversations (id, project_path, agent_type) VALUES (?, '/repo', 'claude-code')").run(SESSION)
  // A stored row that pairs with a transcript line, and one only SQLite has.
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, display_body, pills_meta, timestamp) VALUES ('u298', ?, 'user', 'prompt 298', 'shown 298', '{}', ?)",
  ).run(SESSION, T0 + 298 * 60_000)
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('note', ?, 'assistant', 'stored only', ?)",
  ).run(SESSION, T0 + 297 * 60_000 + 30_000)

  it('pages like the full history, and reads a small part of the file after a restart', async () => {
    writeTranscript(300)
    await fresh()
    const full = (await loadConversationHistory(SESSION, '/repo')).messages
    await fresh()
    await loadConversationHistoryWindow(SESSION, { limit: 50 })
    await fresh()
    const window = await loadConversationHistoryWindow(SESSION, { limit: 50 })
    expect(window.timing.indexHits).toBe(1)
    expect(window.timing.diskBytes).toBeLessThan(readFileSync(path).length / 4)
    expect(window.messages).toEqual(historyWindow(full, { limit: 50 }).messages)
    expect(window.messages.find((message) => message.id === 'u298')?.displayBody).toBe('shown 298')
    const older = await loadConversationHistoryWindow(SESSION, { limit: 50, beforeId: window.nextBeforeId! })
    expect(older.messages).toEqual(historyWindow(full, { limit: 50, beforeId: window.nextBeforeId! }).messages)
  })

  it('parses in full when a slice no longer matches the index', async () => {
    writeTranscript(300)
    await fresh()
    await loadConversationHistoryWindow(SESSION, { limit: 50 })
    // Same size and inode, last 64 KiB untouched: only a slice near turn 250 can see it.
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('"uuid":"u250"', '"uuid":"v250"'))
    await fresh()
    const lookup = await loadConversationHistoryWindow(SESSION, { throughId: 'a250' })
    expect(lookup.timing.indexHits).toBe(0)
    expect(lookup.messages.map((message) => message.id)).toEqual(['a250'])
    // The stale index was dropped, so the next open indexes the file again.
    await fresh()
    const again = await loadConversationHistoryWindow(SESSION, { throughId: 'v250' })
    expect(again.timing.indexHits).toBe(0)
    expect(again.messages.map((message) => message.id)).toEqual(['v250'])
  })
})
