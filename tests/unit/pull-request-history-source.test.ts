/** The transcript reader stops once the scan has enough, and keeps the tool parts the parser drops. */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/db/database', () => ({}))
vi.mock('../../src/main/provider/claude-session-migrate', () => ({
  claudeCandidateDirs: () => [],
  listClaudeSessionCopies: () => [],
}))
vi.mock('../../src/main/provider/codex-session-dirs', () => ({ codexCandidateDirs: () => [] }))
vi.mock('../../src/main/projects/session-scanner', () => ({ scanCodexSessionCopies: async () => [] }))

const { readJsonlHistory } = await import('../../src/main/pull-requests/history-source')

const dir = mkdtempSync(join(tmpdir(), 'sb-e2e-linkscan-'))
afterAll(() => {
  if (dir.startsWith(tmpdir()) && dir.includes('sb-e2e-linkscan-')) rmSync(dir, { recursive: true, force: true })
})

function transcript(name: string, lines: unknown[]): string {
  const path = join(dir, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

const claudeLines = [
  {
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'review 605 please' },
  },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bbpr 605 diff' } },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'PR https://bitbucket.org/geoiq/bot/pull-requests/605' }],
        },
      ],
    },
  },
]

describe('readJsonlHistory', () => {
  it('reads user text, assistant text, tool input and the tool result of a Claude transcript', async () => {
    const parts: Array<[string, string]> = []
    const done = await readJsonlHistory(transcript('claude.jsonl', claudeLines), 'claude-code', (kind, text) => {
      parts.push([kind, text])
      return true
    })
    expect(done).toBe(true)
    expect(parts).toEqual([
      ['text', 'review 605 please'],
      ['text', 'Looking.'],
      ['toolInput', JSON.stringify({ command: 'bbpr 605 diff' }, null, 2)],
      ['toolOutput', 'PR https://bitbucket.org/geoiq/bot/pull-requests/605'],
    ])
  })

  it('reads a Codex tool call and its output', async () => {
    const path = transcript('codex.jsonl', [
      {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00Z',
        payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","bbpr 605"]}' },
      },
      {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:01Z',
        payload: { type: 'function_call_output', output: 'https://bitbucket.org/geoiq/bot/pull-requests/605' },
      },
    ])
    const parts: Array<[string, string]> = []
    await readJsonlHistory(path, 'codex', (kind, text) => {
      parts.push([kind, text])
      return true
    })
    expect(parts).toEqual([
      ['toolInput', '{"command":["bash","-lc","bbpr 605"]}'],
      ['toolOutput', 'https://bitbucket.org/geoiq/bot/pull-requests/605'],
    ])
  })

  it('stops reading the file once the visitor has enough', async () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => ({
      type: 'user',
      uuid: `u${i}`,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: `line ${i}` },
    }))
    let visits = 0
    const done = await readJsonlHistory(transcript('long.jsonl', lines), 'claude-code', () => ++visits < 3)
    expect(done).toBe(false)
    expect(visits).toBe(3)
  })

  it('treats a missing transcript as empty', async () => {
    const visit = vi.fn(() => true)
    expect(await readJsonlHistory(join(dir, 'missing.jsonl'), 'claude-code', visit)).toBe(true)
    expect(visit).not.toHaveBeenCalled()
  })

  it('fails, rather than count a partial read as finished, when a transcript cannot be read', async () => {
    const notAFile = join(dir, 'directory.jsonl')
    mkdirSync(notAFile)
    await expect(readJsonlHistory(notAFile, 'claude-code', () => true)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
