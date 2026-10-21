/** A reopen reads the guard bytes and the appended bytes, never the whole transcript. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
vi.mock('../../src/main/agent/jsonl-memory', () => ({ retainedJsonBytes: () => 200 * 1024 * 1024 }))
import { createReadStream } from 'node:fs'
import { clearJsonlCache, GUARD_BYTES, loadJsonlCached, loadJsonlCopies } from '../../src/main/agent/jsonl-cache'
import type { ChatLoadTiming } from '../../src/shared/perf-chat'

const line = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n'
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
})
const streams = () => vi.mocked(createReadStream).mock.calls.map(([path, opts]) => ({ path, opts }))

describe('jsonl cache guard', () => {
  let dir: string
  beforeEach(async () => {
    clearJsonlCache()
    vi.mocked(createReadStream).mockClear()
    dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-guard-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  // Far more than the guard, so a whole-file read would show in the stream calls.
  const big = () => Array.from({ length: 400 }, (_, i) => line(`m${i}`, 'x'.repeat(400))).join('')

  it('serves a hit without streaming the file', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, big())
    await loadJsonlCached(file, 'claude-code')
    vi.mocked(createReadStream).mockClear()
    const t = timing()
    await loadJsonlCached(file, 'claude-code', t)
    expect(t.cacheHits).toBe(1)
    expect(streams()).toEqual([])
  })

  it('streams only the appended bytes of a grown transcript', async () => {
    const file = join(dir, 's.jsonl')
    const old = big()
    await writeFile(file, old)
    await loadJsonlCached(file, 'claude-code')
    vi.mocked(createReadStream).mockClear()
    await appendFile(file, line('new', 'tail'))
    const t = timing()
    const messages = await loadJsonlCached(file, 'claude-code', t)
    expect(messages?.at(-1)?.id).toBe('new')
    expect(streams().map((call) => (call.opts as { start?: number }).start)).toEqual([Buffer.byteLength(old)])
    expect(t.diskBytes).toBe(Buffer.byteLength(line('new', 'tail')))
  })

  it('parses in full when the guard bytes changed before the append', async () => {
    const file = join(dir, 's.jsonl')
    const old = big()
    await writeFile(file, old)
    await loadJsonlCached(file, 'claude-code')
    expect(Buffer.byteLength(old)).toBeGreaterThan(GUARD_BYTES)
    // The last line sits inside the guard.
    await writeFile(file, old.replace('"m399"', '"zzzz"') + line('new', 'tail'))
    const messages = await loadJsonlCached(file, 'claude-code')
    expect(messages?.map((m) => m.id).slice(-2)).toEqual(['zzzz', 'new'])
  })

  it('keeps a transcript bigger than the byte budget cached', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, line('a', 'one'))
    await loadJsonlCached(file, 'claude-code')
    const t = timing()
    await loadJsonlCached(file, 'claude-code', t)
    expect(t.cacheHits).toBe(1)
  })

  it('keeps a prefix proof while the newest copy only grows', async () => {
    const full = join(dir, 'full.jsonl')
    const prefix = join(dir, 'prefix.jsonl')
    await writeFile(prefix, big())
    await writeFile(full, big() + line('b', 'two'))
    expect((await loadJsonlCopies([full, prefix], 'claude-code', timing())).length).toBe(1)
    await appendFile(full, line('c', 'three'))
    vi.mocked(createReadStream).mockClear()
    const t = timing()
    const out = await loadJsonlCopies([full, prefix], 'claude-code', t)
    expect(out.map((copy) => copy.messages.at(-1)?.id)).toEqual(['c'])
    expect(t.prefixSkips).toBe(1)
    expect(streams().map((call) => call.path)).toEqual([full])
  })
})
