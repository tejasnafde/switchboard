/**
 * Synthetic timing of the history window's SQLite reads on the main connection
 * and on the read-only one. Run with
 * `SB_PERF_BENCH=1 npx vitest run tests/unit/history-read-connection-benchmark.test.ts`.
 */
import { expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb, getDisplayBodyEnrichments, getReadDb, messageWindowRows } from '../../src/main/db/database'
import { mergeHistoryWindow, windowDiskOf } from '../../src/main/conversations/history-window'

const MESSAGES = 20_000
const RUNS = 20
const T0 = Date.UTC(2026, 0, 1)

function seed(): void {
  const db = getDb()
  db.exec("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')")
  db.exec("INSERT INTO conversations (id, project_path) VALUES ('big', '/repo')")
  const insert = db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, tool_calls, images, display_body, pills_meta, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const image = JSON.stringify([{ mediaType: 'image/png', data: 'A'.repeat(40_000) }])
  db.transaction(() => {
    for (let at = 0; at < MESSAGES; at++) {
      const user = at % 10 === 0
      insert.run(
        `m${at}`,
        'big',
        user ? 'user' : 'assistant',
        `${user ? 'prompt' : 'reply'} ${at} ${'x'.repeat(user ? 200 : 2000)}`,
        user ? null : JSON.stringify([{ id: `t${at}`, name: 'Read', input: { path: `/repo/f${at}.ts` } }]),
        user && at % 500 === 0 ? image : null,
        user ? `shown ${at}` : null,
        user ? '{}' : null,
        T0 + at * 1000,
      )
    }
  })()
}

/** One open: the newest page, the page before it, and the enrichments for both. */
function windowRead(): number {
  const start = performance.now()
  const rows = messageWindowRows(['big'])
  const newest = mergeHistoryWindow(windowDiskOf([]), rows, { limit: 100 })
  const older = mergeHistoryWindow(windowDiskOf([]), rows, { limit: 100, beforeId: newest.messages[0].id })
  const contents = new Set(
    [...newest.messages, ...older.messages].filter((m) => m.role === 'user').map((m) => m.content),
  )
  getDisplayBodyEnrichments('big', contents)
  expect(newest.messages.length).toBe(100)
  return performance.now() - start
}

function measure(mode: 'main' | 'read'): { cold: number; median: number; p90: number } {
  closeDb()
  const main = getDb()
  if (mode === 'main') {
    // A reader that cannot open falls back to the main connection.
    chmodSync(main.name, 0o000)
    expect(getReadDb()).toBe(main)
    chmodSync(main.name, 0o644)
  } else {
    expect(getReadDb().readonly).toBe(true)
  }
  const cold = windowRead()
  const warm = Array.from({ length: RUNS }, windowRead).sort((a, b) => a - b)
  return { cold, median: warm[Math.floor(RUNS / 2)], p90: warm[Math.ceil(RUNS * 0.9) - 1] }
}

it.skipIf(!process.env.SB_PERF_BENCH)(
  'times the history window reads on the main and the read-only connection',
  () => {
    const previousDataDir = process.env.SWITCHBOARD_DATA_DIR
    const root = mkdtempSync(join(tmpdir(), 'sb-read-bench-'))
    process.env.SWITCHBOARD_DATA_DIR = root
    try {
      seed()
      const round = (n: number) => Math.round(n * 100) / 100
      for (const mode of ['main', 'read', 'main', 'read'] as const) {
        const { cold, median, p90 } = measure(mode)
        console.log(
          JSON.stringify({ mode, messages: MESSAGES, coldMs: round(cold), medianMs: round(median), p90Ms: round(p90) }),
        )
      }
    } finally {
      closeDb()
      if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR
      else process.env.SWITCHBOARD_DATA_DIR = previousDataDir
      rmSync(root, { recursive: true, force: true })
    }
  },
  120_000,
)
