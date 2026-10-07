/** Profile copies that are byte prefixes of the newest copy are proven by hash and not parsed. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrefixHasher, clearJsonlCache, loadJsonlCopies } from '../../src/main/agent/jsonl-cache'
import type { ChatLoadTiming } from '../../src/shared/perf-chat'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const line = (uuid: string, text: string) => JSON.stringify({
  type: 'assistant', uuid, timestamp: '2026-01-01T00:00:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
}) + '\n'
const timing = (): ChatLoadTiming => ({ readMs: 0, parseMs: 0, diskMs: 0, dbMs: 0, mergeMs: 0, enrichMs: 0, diskBytes: 0, diskLines: 0, cacheHits: 0, prefixSkips: 0 })

describe('PrefixHasher', () => {
  it('digests every requested prefix across chunk boundaries', () => {
    const data = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const sizes = [0, 1, 7, 8, 13, 26, 40]
    for (const chunk of [1, 3, 8, 26]) {
      const hasher = new PrefixHasher(sizes)
      for (let at = 0; at < data.length; at += chunk) hasher.update(data.subarray(at, at + chunk))
      expect(hasher.digest()).toBe(sha(data))
      expect(hasher.size).toBe(26)
      for (const size of [0, 1, 7, 8, 13, 26]) expect(hasher.prefixes.get(size)).toBe(sha(data.subarray(0, size)))
      expect(hasher.prefixes.has(40)).toBe(false)
    }
  })
})

describe('loadJsonlCopies', () => {
  let dir: string
  beforeEach(async () => {
    clearJsonlCache()
    dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-copies-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('parses the newest copy once and skips its prefix copies', async () => {
    const full = join(dir, 'full.jsonl')
    const prefix = join(dir, 'prefix.jsonl')
    await writeFile(full, line('a', 'one') + line('b', 'two') + line('c', 'three'))
    await writeFile(prefix, line('a', 'one') + line('b', 'two'))
    const t = timing()
    const out = await loadJsonlCopies([full, prefix], 'claude-code', t)
    expect(out.map((copy) => copy.path)).toEqual([full])
    expect(out[0].messages.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(t.prefixSkips).toBe(1)
    // A cache hit still proves the prefix from the bytes it hashed.
    const again = timing()
    expect((await loadJsonlCopies([full, prefix], 'claude-code', again)).length).toBe(1)
    expect(again).toMatchObject({ cacheHits: 1, prefixSkips: 1 })
  })

  it('parses a copy that diverged, even at the same length', async () => {
    const full = join(dir, 'full.jsonl')
    const other = join(dir, 'other.jsonl')
    await writeFile(full, line('a', 'one') + line('b', 'two'))
    await writeFile(other, line('a', 'one') + line('x', 'owt'))
    const t = timing()
    const out = await loadJsonlCopies([full, other], 'claude-code', t)
    expect(out.map((copy) => copy.messages.map((m) => m.id))).toEqual([['a', 'b'], ['a', 'x']])
    expect(t.prefixSkips).toBe(0)
  })

  it('skips missing copies and survives a missing newest copy', async () => {
    const prefix = join(dir, 'prefix.jsonl')
    await writeFile(prefix, line('a', 'one'))
    const out = await loadJsonlCopies([join(dir, 'gone.jsonl'), prefix, join(dir, 'gone2.jsonl')], 'claude-code', timing())
    expect(out.map((copy) => copy.path)).toEqual([prefix])
  })
})

describe('loadJsonlCopies on a growing transcript', () => {
  let dir: string
  beforeEach(async () => {
    clearJsonlCache()
    dir = await mkdtemp(join(tmpdir(), 'sb-jsonl-grow-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('parses only the appended lines when the old bytes are unchanged', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, line('a', 'one'))
    const [first] = await loadJsonlCopies([file], 'claude-code', timing())
    await appendFile(file, line('b', 'two'))
    const t = timing()
    const [second] = await loadJsonlCopies([file], 'claude-code', t)
    expect(second.messages.map((m) => m.id)).toEqual(['a', 'b'])
    // The old row is the cached object, not a re-parse of it.
    expect(second.messages[0]).toBe(first.messages[0])
    expect(t.diskBytes).toBe(Buffer.byteLength(line('b', 'two')))
  })

  it('parses in full when the old bytes changed before growing', async () => {
    const file = join(dir, 's.jsonl')
    await writeFile(file, line('a', 'one'))
    await loadJsonlCopies([file], 'claude-code', timing())
    await writeFile(file, line('a', 'ONE') + line('b', 'two'))
    const [out] = await loadJsonlCopies([file], 'claude-code', timing())
    expect(out.messages.map((m) => m.content)).toEqual(['ONE', 'two'])
  })

  it('parses in full when the cached bytes ended mid-line', async () => {
    const file = join(dir, 's.jsonl')
    const whole = line('a', 'one') + line('b', 'two')
    await writeFile(file, whole.slice(0, whole.length - 10))
    expect((await loadJsonlCopies([file], 'claude-code', timing()))[0].messages.map((m) => m.id)).toEqual(['a'])
    await writeFile(file, whole)
    expect((await loadJsonlCopies([file], 'claude-code', timing()))[0].messages.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
