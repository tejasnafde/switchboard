import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, appendFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
