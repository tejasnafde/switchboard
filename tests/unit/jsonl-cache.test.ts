import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, writeFile, appendFile, rm, utimes, rename, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlParser } from '../../src/main/agent/jsonl-parser'
import { appendFileSync } from 'node:fs'
import { loadJsonlCached, clearJsonlCache } from '../../src/main/agent/jsonl-cache'

// Minimal claude-code JSONL line the parser accepts.
function line(text: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n'
}

describe('loadJsonlCached', () => {
  beforeEach(() => clearJsonlCache())

  it('parses, then serves the identical array from cache when unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
    try {
      const file = join(dir, 's.jsonl')
      await writeFile(file, line('hello', '2026-01-01T00:00:00Z'))
      const first = await loadJsonlCached(file, 'claude-code')
      expect(first).not.toBeNull()
      expect(first!.length).toBe(1)
      const second = await loadJsonlCached(file, 'claude-code')
      // Same reference = cache hit, no re-parse.
      expect(second).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-parses when the file grows (append-only rotation)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
    try {
      const file = join(dir, 's.jsonl')
      await writeFile(file, line('one', '2026-01-01T00:00:00Z'))
      const first = await loadJsonlCached(file, 'claude-code')
      expect(first!.length).toBe(1)
      await appendFile(file, line('two', '2026-01-01T00:00:01Z'))
      // Force a distinct mtime even on coarse filesystems.
      await utimes(file, new Date(), new Date(Date.now() + 5000))
      const second = await loadJsonlCached(file, 'claude-code')
      expect(second!.length).toBe(2)
      expect(second).not.toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a missing file instead of throwing', async () => {
    expect(await loadJsonlCached('/nope/missing.jsonl', 'claude-code')).toBeNull()
  })
})


it.each(['rewrite', 'replace'])('invalidates a same-size %s with the original mtime', async (change) => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  try {
    const path = join(dir, 'session.jsonl')
    const at = new Date('2026-01-01T00:00:00Z')
    await writeFile(path, line('one', at.toISOString()))
    await utimes(path, at, at)
    await loadJsonlCached(path, 'claude-code')
    const replacement = change === 'replace' ? path + '.new' : path
    await writeFile(replacement, line('two', at.toISOString()))
    await utimes(replacement, at, at)
    if (change === 'replace') await rename(replacement, path)
    expect((await loadJsonlCached(path, 'claude-code'))?.[0].content).toBe('two')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('yields to the event loop while parsing a large cold history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  try {
    const path = join(dir, 'large.jsonl')
    await writeFile(path, line('x'.repeat(4096), '2026-01-01T00:00:00Z').repeat(2000))
    let yielded = false
    let yieldedBetweenChunks = false
    let chunks = 0
    const original = JsonlParser.prototype.feed
    const feed = vi.spyOn(JsonlParser.prototype, 'feed').mockImplementation(function (this: JsonlParser, chunk) {
      if (chunks++ > 0 && yielded) yieldedBetweenChunks = true
      setImmediate(() => { yielded = true })
      original.call(this, chunk)
    })
    try {
      await loadJsonlCached(path, 'claude-code')
      expect(yieldedBetweenChunks).toBe(true)
    } finally { feed.mockRestore() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})


it('retains small parsed histories from two large tool-output transcripts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  try {
    const path = join(dir, 'one.jsonl')
    const other = join(dir, 'two.jsonl')
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(64 * 1024) }] } }) + '\n'
    await writeFile(path, line('hello', '2026-01-01T00:00:00Z') + result.repeat(1025))
    await copyFile(path, other)
    const first = await loadJsonlCached(path, 'claude-code')
    await loadJsonlCached(other, 'claude-code')
    expect(await loadJsonlCached(path, 'claude-code')).toBe(first)
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 20_000)

it('does not cache a file changed during parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  try {
    const path = join(dir, 'changed.jsonl')
    await writeFile(path, line('one', '2026-01-01T00:00:00Z'))
    const original = JsonlParser.prototype.feed
    const feed = vi.spyOn(JsonlParser.prototype, 'feed').mockImplementationOnce(function (this: JsonlParser, chunk) {
      appendFileSync(path, line('two', '2026-01-01T00:00:01Z'))
      original.call(this, chunk)
    })
    let first
    try { first = await loadJsonlCached(path, 'claude-code') }
    finally { feed.mockRestore() }
    const second = await loadJsonlCached(path, 'claude-code')
    expect(second).not.toBe(first)
    expect(second?.map((m) => m.content)).toEqual(['one', 'two'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('evicts the least recently used entry after 24 paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  clearJsonlCache()
  try {
    const path = join(dir, '0.jsonl')
    await writeFile(path, line('one', '2026-01-01T00:00:00Z'))
    const first = await loadJsonlCached(path, 'claude-code')
    for (let i = 1; i < 25; i++) {
      const next = join(dir, `${i}.jsonl`)
      await writeFile(next, line('one', '2026-01-01T00:00:00Z'))
      await loadJsonlCached(next, 'claude-code')
    }
    expect(await loadJsonlCached(path, 'claude-code')).not.toBe(first)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('keys the cache by both parser source and path and invalidates truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-cache-'))
  try {
    const path = join(dir, 'source.jsonl')
    await writeFile(path, line('one', '2026-01-01T00:00:00Z'))
    expect((await loadJsonlCached(path, 'claude-code'))?.length).toBe(1)
    expect(await loadJsonlCached(path, 'codex')).toEqual([])
    await writeFile(path, '')
    expect(await loadJsonlCached(path, 'claude-code')).toEqual([])
    await rm(path)
    expect(await loadJsonlCached(path, 'claude-code')).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
