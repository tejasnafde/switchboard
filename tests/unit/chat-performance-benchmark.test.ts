import { expect, it, vi } from 'vitest'
import { mkdtemp, open, rm, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatMessage } from '../../src/shared/types'
import { getDb, closeDb, addProject, createConversation } from '../../src/main/db/database'
import { clearJsonlCache } from '../../src/main/agent/jsonl-cache'
import { prepareClaudeProfileSwitch, claudeSessionResumePath } from '../../src/main/provider/claude-session-migrate'
import {
  compareJsonlTranscripts,
  synchronizeCompatibleTranscript,
} from '../../src/main/provider/transcript-compatibility'

let root = ''
let secondCopy: string | undefined
const mirror: ChatMessage[] = []
vi.mock('../../src/main/provider/claude-session-migrate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claudeCandidateDirs: () => [root],
  listClaudeSessionCopies: () => [{ path: join(root, 'source.jsonl') }, ...(secondCopy ? [{ path: secondCopy }] : [])],
}))
vi.mock('../../src/main/provider/codex-session-dirs', () => ({ codexCandidateDirs: () => [] }))
vi.mock('../../src/main/projects/session-scanner', () => ({
  scanCodexSessionCopies: async () => [],
  encodeClaudeProjectPath: (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-'),
}))
const { loadConversationHistory } = await import('../../src/main/conversations/history')

it.skipIf(!process.env.SB_PERF_BENCH)(
  'measures synthetic 80 MiB history and transcript switch without accounts',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'sb-perf2-benchmark-'))
    try {
      const source = join(root, 'source.jsonl')
      const target = join(root, 'target.jsonl')
      const file = await open(source, 'w')
      let bytes = 0
      let turns = 0
      try {
        while (bytes < 80 * 1024 * 1024) {
          const timestamp = 1_770_000_000_000 + turns * 60_000
          const records = [
            {
              type: 'user',
              uuid: `u${turns}`,
              timestamp,
              message: {
                content: [
                  { type: 'text', text: `Synthetic task ${turns}` },
                  ...(turns % 50 === 0
                    ? [
                        {
                          type: 'image',
                          source: { type: 'base64', media_type: 'image/png', data: 'YWJj'.repeat(4096) },
                        },
                      ]
                    : []),
                ],
              },
            },
            {
              type: 'assistant',
              uuid: `a${turns}`,
              timestamp: timestamp + 1,
              message: {
                content: [
                  { type: 'text', text: `Synthetic response ${turns}` },
                  { type: 'tool_use', id: `tool${turns}`, name: 'Read', input: { file_path: '/synthetic/output.txt' } },
                ],
              },
            },
            {
              type: 'user',
              uuid: `r${turns}`,
              timestamp: timestamp + 2,
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: `tool${turns}`, content: 'Synthetic output. '.repeat(4096) },
                ],
              },
            },
            ...(turns === 500
              ? [
                  {
                    type: 'system',
                    subtype: 'compact_boundary',
                    compactMetadata: { trigger: 'auto', preTokens: 100000 },
                  },
                ]
              : []),
          ]
          const chunk = records.map((record) => JSON.stringify(record) + '\n').join('')
          await file.write(chunk)
          bytes += Buffer.byteLength(chunk)
          mirror.push({
            id: `db${turns}`,
            role: 'assistant',
            content: `Synthetic response ${turns}`,
            timestamp: timestamp + 1,
          })
          turns++
        }
      } finally {
        await file.close()
      }
      async function measure(name: string, run: () => Promise<unknown>) {
        const start = performance.now()
        const result = await run()
        console.log(
          JSON.stringify({
            name,
            ms: Math.round((performance.now() - start) * 10) / 10,
            ...(name.startsWith('history') ? { timing: (result as { timing: unknown }).timing } : {}),
          }),
        )
        return result
      }
      const db = getDb()
      addProject('/synthetic', 'Synthetic')
      createConversation('synthetic', '/synthetic', 'claude-code', 'Synthetic')
      const insert = db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
      )
      db.transaction(() => {
        for (const message of mirror)
          insert.run(message.id, 'synthetic', message.role, message.content, message.timestamp)
      })()
      const queries = [
        ['messages', 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'],
        [
          'enrich',
          "SELECT content, display_body, pills_meta, images FROM messages WHERE conversation_id = ? AND role = 'user' AND (display_body IS NOT NULL OR images IS NOT NULL)",
        ],
        ['root', 'SELECT thread_id FROM thread_sessions WHERE claude_session_id = ?'],
        [
          'family',
          'SELECT claude_session_id, recorded_at FROM thread_sessions WHERE thread_id = ? ORDER BY recorded_at ASC',
        ],
        ['hints', 'SELECT session_id FROM conversations WHERE id = ?'],
        [
          'segments',
          'SELECT * FROM conversation_segments WHERE conversation_id = ? ORDER BY ordinal ASC, created_at ASC',
        ],
        ['profile', 'SELECT provider_instance_id FROM conversations WHERE id = ?'],
      ]
      for (const [name, sql] of queries) {
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all('synthetic')
        const start = performance.now()
        db.prepare(sql).all('synthetic')
        console.log(JSON.stringify({ query: name, plan, ms: performance.now() - start }))
      }
      console.log(JSON.stringify({ bytes, turns }))
      clearJsonlCache()
      expect(
        (
          (await measure('history.cold', () => loadConversationHistory('synthetic', '/synthetic'))) as {
            messages: unknown[]
          }
        ).messages.length,
      ).toBeGreaterThan(turns)
      await measure('history.warm', () => loadConversationHistory('synthetic', '/synthetic'))
      await measure('switch.missing', () => synchronizeCompatibleTranscript(source, target))
      await measure('switch.equal', () => synchronizeCompatibleTranscript(source, target))
      await copyFile(source, join(root, 'equal.jsonl'))
      await measure('compare.equal.cold', () => compareJsonlTranscripts(source, join(root, 'equal.jsonl')))
      await measure('compare.equal.warm', () => compareJsonlTranscripts(source, join(root, 'equal.jsonl')))
      secondCopy = join(root, 'equal.jsonl')
      await measure('history.two-copies.cold', () => loadConversationHistory('synthetic', '/synthetic'))
      await measure('history.two-copies.warm', () => loadConversationHistory('synthetic', '/synthetic'))
      const fromDir = join(root, 'source-profile')
      const toDir = join(root, 'target-profile')
      const resumePath = claudeSessionResumePath(fromDir, 'synthetic', '/synthetic')
      await mkdir(dirname(resumePath), { recursive: true })
      await copyFile(source, resumePath)
      const prepare = () => prepareClaudeProfileSwitch({ sessionId: 'synthetic', cwd: '/synthetic', fromDir, toDir })
      await measure('profile.prepare.missing', prepare)
      await measure('profile.prepare.equal', prepare)
    } finally {
      await rm(root, { recursive: true, force: true })
      secondCopy = undefined
      mirror.length = 0
      closeDb()
    }
  },
  120_000,
)
