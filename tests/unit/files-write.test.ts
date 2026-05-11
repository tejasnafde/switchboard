/**
 * `writeFileSafe` is the pure IO helper behind the `files:write-file`
 * IPC. It:
 *   - sniffs the existing file's EOL (`\r\n` vs `\n`) and preserves it
 *   - writes atomically (`<path>.tmp` + `rename`)
 *   - detects mtime drift — if the on-disk file changed since the
 *     editor opened it, save fails with a `conflict` flag so the
 *     renderer can show "Reload from disk?" UX
 *   - creates the file if it doesn't exist (no expectedMtime needed)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSafe } from '../../src/main/files/writing'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sb-write-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('writeFileSafe — basic write', () => {
  it('creates a new file when it does not exist', async () => {
    const abs = join(tmp, 'new.txt')
    const res = await writeFileSafe(abs, 'hello')
    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf8')).toBe('hello')
  })

  it('overwrites an existing file when expectedMtime matches', async () => {
    const abs = join(tmp, 'a.txt')
    writeFileSync(abs, 'v1')
    const stat = statSync(abs)
    const res = await writeFileSafe(abs, 'v2', { expectedMtimeMs: stat.mtimeMs })
    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf8')).toBe('v2')
  })

  it('returns the new file mtime on success', async () => {
    const abs = join(tmp, 'a.txt')
    const res = await writeFileSafe(abs, 'hi')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(typeof res.mtimeMs).toBe('number')
      expect(res.mtimeMs).toBeGreaterThan(0)
    }
  })
})

describe('writeFileSafe — mtime conflict detection', () => {
  it('rejects with conflict=true when the on-disk mtime drifts past expectedMtime', async () => {
    const abs = join(tmp, 'a.txt')
    writeFileSync(abs, 'v1')
    const oldMtime = 1000 // arbitrarily small — actual stat will be much larger
    const res = await writeFileSafe(abs, 'v2', { expectedMtimeMs: oldMtime })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.conflict).toBe(true)
    }
    // File should remain unchanged
    expect(readFileSync(abs, 'utf8')).toBe('v1')
  })

  it('does NOT check mtime when expectedMtime is omitted', async () => {
    const abs = join(tmp, 'a.txt')
    writeFileSync(abs, 'v1')
    const res = await writeFileSafe(abs, 'v2')
    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf8')).toBe('v2')
  })
})

describe('writeFileSafe — EOL preservation', () => {
  it('preserves \\r\\n line endings when the existing file uses CRLF', async () => {
    const abs = join(tmp, 'crlf.txt')
    writeFileSync(abs, 'a\r\nb\r\nc')
    const stat = statSync(abs)
    // Caller passes LF-normalized content; writer re-translates.
    await writeFileSafe(abs, 'a\nb\nc', { expectedMtimeMs: stat.mtimeMs })
    expect(readFileSync(abs, 'utf8')).toBe('a\r\nb\r\nc')
  })

  it('keeps \\n endings as-is for LF files', async () => {
    const abs = join(tmp, 'lf.txt')
    writeFileSync(abs, 'a\nb\n')
    const stat = statSync(abs)
    await writeFileSafe(abs, 'a\nb\n', { expectedMtimeMs: stat.mtimeMs })
    expect(readFileSync(abs, 'utf8')).toBe('a\nb\n')
  })

  it('defaults to LF for new files', async () => {
    const abs = join(tmp, 'new.txt')
    await writeFileSafe(abs, 'a\nb\nc\n')
    expect(readFileSync(abs, 'utf8')).toBe('a\nb\nc\n')
  })
})
