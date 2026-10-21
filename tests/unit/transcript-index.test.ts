/** A history window read through the transcript byte-offset index equals one cut from a full parse. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatLoadTiming } from '../../src/shared/perf-chat'
import type { ChatMessage } from '../../src/shared/types'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
const { clearJsonlCache, loadJsonlCached } = await import('../../src/main/agent/jsonl-cache')
const { clearTranscriptIndexMemory, openIndexedCopies, StaleTranscriptIndexError } =
  await import('../../src/main/agent/transcript-index')
const { mergeHistoryWindow } = await import('../../src/main/conversations/history-window')

const dir = mkdtempSync(join(tmpdir(), 'sb-transcript-index-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const timing = (): ChatLoadTiming => ({
  readMs: 0,
  parseMs: 0,
  diskMs: 0,
  dbMs: 0,
  mergeMs: 0,
  enrichMs: 0,
  diskBytes: 0,
  diskLines: 0,
  cacheHits: 0,
  prefixSkips: 0,
  hashMs: 0,
  indexHits: 0,
})

const noRows = {
  newestTimestamps: () => [],
  userTimestampsBefore: () => [],
  userTimestampsAfter: () => [],
  read: () => [],
  timestampOf: () => undefined,
  hasRowBefore: () => false,
  count: () => 0,
}

const T0 = Date.UTC(2026, 0, 1)
const iso = (at: number) => new Date(T0 + at * 1000).toISOString()

/** A turn: prompt, a Bash call with a big result, an error, and a reply. Turn 3 starts a subagent answered at the end. */
function turnLines(turn: number, last: number): string[] {
  const at = turn * 100
  const lines = [
    { type: 'user', uuid: `u${turn}`, timestamp: iso(at), message: { role: 'user', content: `prompt ${turn}` } },
    {
      type: 'assistant',
      uuid: `c${turn}`,
      timestamp: iso(at + 1),
      message: { content: [{ type: 'tool_use', id: `t${turn}`, name: 'Bash', input: { command: 'ls' } }] },
    },
    {
      type: 'user',
      uuid: `r${turn}`,
      timestamp: iso(at + 2),
      message: {
        content: [
          { type: 'tool_result', tool_use_id: `t${turn}`, content: 'x'.repeat(4000), is_error: turn % 4 === 0 },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: `a${turn}`,
      timestamp: iso(at + 3),
      message: { content: [{ type: 'text', text: `reply ${turn}` }] },
    },
  ]
  if (turn === 3) {
    lines.push({
      type: 'assistant',
      uuid: 'agent-call',
      timestamp: iso(at + 4),
      message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'go' } }] },
    })
  }
  if (turn === last) {
    lines.push({
      type: 'user',
      uuid: 'agent-result',
      timestamp: iso(at + 5),
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: [{ type: 'text', text: 'report' }] }],
      },
    })
  }
  return lines.map((line) => JSON.stringify(line))
}

function transcript(name: string, turns: number): string {
  const path = join(dir, `${name}.jsonl`)
  const lines: string[] = []
  for (let turn = 0; turn < turns; turn++) lines.push(...turnLines(turn, turns - 1))
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

async function full(path: string): Promise<ChatMessage[]> {
  clearJsonlCache()
  return (await loadJsonlCached(path, 'claude-code'))!
}

async function indexed(paths: string[], t = timing()) {
  const copies = await openIndexedCopies(paths, 'claude-code', t)
  expect(copies).not.toBeNull()
  const transcripts = copies!
  expect(transcripts).toHaveLength(1)
  return { metas: transcripts[0].messages, materialize: transcripts[0].materialize }
}

/** Every page of the history, newest first, with `limit` messages each. */
function pages(disk: Parameters<typeof mergeHistoryWindow>[0], limit: number) {
  const out: ChatMessage[][] = []
  let beforeId: string | undefined
  for (;;) {
    const page = mergeHistoryWindow(disk, noRows, { limit, beforeId })
    out.push(page.messages)
    if (!page.nextBeforeId) return out
    beforeId = page.nextBeforeId
  }
}

beforeEach(async () => {
  await clearTranscriptIndexMemory()
  clearJsonlCache()
})

describe('transcript index', () => {
  it('pages a window exactly as a full parse does, results after the slice included', async () => {
    const path = transcript('parity', 40)
    const expected = pages(await full(path), 7)
    expect(pages(await indexed([path]), 7)).toEqual(expected)
    // The subagent call (turn 3) got its report from the last line of the file.
    const agent = expected.flat().find((message) => message.id === 'agent-call')
    expect(agent?.toolCalls?.[0].output).toBe('report')
    expect(expected.flat().find((message) => message.id === 'c4')?.toolCalls?.[0].isError).toBe(true)
  })

  it('reads only the window after a restart, not the whole file', async () => {
    const path = transcript('restart', 200)
    await indexed([path])
    await clearTranscriptIndexMemory()
    const t = timing()
    const disk = await indexed([path], t)
    expect(t.indexHits).toBe(1)
    mergeHistoryWindow(disk, noRows, { limit: 20 })
    expect(t.diskBytes).toBeLessThan(statSync(path).size / 4)
  })

  it('parses only appended bytes, and a later result still marks an indexed call', async () => {
    const path = transcript('append', 10)
    await indexed([path])
    const pending = {
      type: 'assistant',
      uuid: 'late-call',
      timestamp: iso(5000),
      message: { content: [{ type: 'tool_use', id: 'late', name: 'Task', input: {} }] },
    }
    appendFileSync(path, JSON.stringify(pending) + '\n')
    await indexed([path])
    await clearTranscriptIndexMemory()
    const tail = JSON.stringify({
      type: 'user',
      uuid: 'late-result',
      timestamp: iso(5001),
      message: { content: [{ type: 'tool_result', tool_use_id: 'late', content: 'done', is_error: true }] },
    })
    appendFileSync(path, tail + '\n')
    const t = timing()
    const disk = await indexed([path], t)
    expect(t.diskBytes).toBe(Buffer.byteLength(tail) + 1)
    expect(pages(disk, 7)).toEqual(pages(await full(path), 7))
    const late = disk.materialize([disk.metas.findIndex((message) => message.id === 'late-call')])[0]
    expect(late.toolCalls?.[0]).toMatchObject({ isError: true, output: 'done' })
  })

  it('parses a last line with no line break on each open, and indexes it once complete', async () => {
    const path = transcript('partial', 5)
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'partial-line',
      timestamp: iso(900),
      message: { content: [{ type: 'text', text: 'almost' }] },
    })
    appendFileSync(path, line)
    let disk = await indexed([path])
    expect(disk.metas.at(-1)?.id).toBe('partial-line')
    expect(disk.materialize([disk.metas.length - 1])[0].content).toBe('almost')
    appendFileSync(path, '\n')
    await clearTranscriptIndexMemory()
    const t = timing()
    disk = await indexed([path], t)
    // The completed line is read once more, now as a whole line.
    expect(t.diskBytes).toBe(Buffer.byteLength(line) + 1)
    expect(pages(disk, 4)).toEqual(pages(await full(path), 4))
  })

  it('indexes again from byte 0 when the bytes before the indexed end change', async () => {
    const path = transcript('rewrite', 10)
    await indexed([path])
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('reply 9', 'reply X'))
    const t = timing()
    const disk = await indexed([path], t)
    expect(t.indexHits).toBe(0)
    expect(t.diskBytes).toBe(statSync(path).size)
    expect(pages(disk, 7)).toEqual(pages(await full(path), 7))
  })

  it('throws StaleTranscriptIndexError when a slice no longer matches the index', async () => {
    const path = transcript('stale', 60)
    const disk = await indexed([path])
    // Same size, same inode, and the last 64 KiB untouched: only a slice can see it.
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('"uuid":"u1"', '"uuid":"v1"'))
    expect(() => disk.materialize([disk.metas.findIndex((message) => message.id === 'u1')])).toThrow(
      StaleTranscriptIndexError,
    )
  })

  it('proves a profile copy a prefix once, and keeps the proof across a restart', async () => {
    const head = transcript('head', 12)
    const copy = join(dir, 'copy.jsonl')
    const text = readFileSync(head, 'utf8')
    writeFileSync(copy, text.slice(0, text.indexOf('\n', text.length / 2) + 1))
    let t = timing()
    await indexed([head, copy], t)
    expect(t.prefixSkips).toBe(1)
    await clearTranscriptIndexMemory()
    t = timing()
    await indexed([head, copy], t)
    expect(t.prefixSkips).toBe(1)
    expect(t.diskBytes).toBe(0)
    expect(t.hashMs).toBe(0)
    // A changed copy is proven again.
    utimesSync(copy, new Date(T0), new Date(T0))
    t = timing()
    await indexed([head, copy], t)
    expect(t.hashMs).toBeGreaterThan(0)
  })

  it('indexes a copy that is not a prefix on its own', async () => {
    const head = transcript('head2', 12)
    const other = join(dir, 'other.jsonl')
    writeFileSync(other, readFileSync(transcript('tmp', 3), 'utf8').replace('prompt 0', 'prompt Z'))
    const copies = await openIndexedCopies([head, other], 'claude-code', timing())
    expect(copies).toHaveLength(2)
    expect(copies![1].materialize([0])[0].content).toBe('prompt Z')
  })

  it('treats a file removed after the open as stale', async () => {
    const path = transcript('removed', 5)
    const disk = await indexed([path])
    rmSync(path)
    expect(() => disk.materialize([0])).toThrow(StaleTranscriptIndexError)
  })

  it('applies a result in a last line with no line break, as a full parse does', async () => {
    const path = transcript('tail-result', 5)
    appendFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        uuid: 'tail-call',
        timestamp: iso(900),
        message: { content: [{ type: 'tool_use', id: 'tc', name: 'Bash', input: {} }] },
      }) + '\n',
    )
    await indexed([path])
    appendFileSync(
      path,
      JSON.stringify({
        type: 'user',
        uuid: 'tail-result-line',
        timestamp: iso(901),
        message: { content: [{ type: 'tool_result', tool_use_id: 'tc', content: 'no', is_error: true }] },
      }),
    )
    const disk = await indexed([path])
    const call = disk.materialize([disk.metas.findIndex((message) => message.id === 'tail-call')])[0]
    expect(call.toolCalls?.[0].isError).toBe(true)
    expect(pages(disk, 4)).toEqual(pages(await full(path), 4))
  })
})
