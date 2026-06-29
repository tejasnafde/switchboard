/**
 * Edge-case coverage for the file-IO primitives:
 *   - resolveWithinRepo must defeat symlink escapes (E2) - lexical-only
 *     checks let a symlink inside the repo point outside it.
 *   - readFileCapped must not slice mid-UTF-8-codepoint at the cap (E4).
 *   - detectEol / applyEol must survive leading bare \n and lone \r (E9/E10).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWithinRepo } from '../../src/main/ipc/files'
import { readFileCapped } from '../../src/main/files/listing'
import { writeFileSafe } from '../../src/main/files/writing'

let repo: string
let outside: string

beforeEach(async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'sb-files-'))
  repo = join(base, 'repo')
  outside = join(base, 'outside')
  await fs.mkdir(repo)
  await fs.mkdir(outside)
})
afterEach(async () => {
  await fs.rm(join(repo, '..'), { recursive: true, force: true })
})

describe('resolveWithinRepo (E2 symlink guard)', () => {
  it('resolves a normal path inside the repo', async () => {
    await fs.writeFile(join(repo, 'a.txt'), 'hi')
    const abs = await resolveWithinRepo(repo, 'a.txt')
    expect(abs).toBe(join(repo, 'a.txt'))
  })

  it('allows a not-yet-existing path inside the repo (new file write)', async () => {
    const abs = await resolveWithinRepo(repo, 'sub/new.txt')
    expect(abs).toBe(join(repo, 'sub', 'new.txt'))
  })

  it('rejects ../ traversal', async () => {
    await expect(resolveWithinRepo(repo, '../outside/secret.txt')).rejects.toThrow()
  })

  it('rejects a symlink that points outside the repo', async () => {
    await fs.writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
    // symlink inside repo -> the outside dir
    await fs.symlink(outside, join(repo, 'link'))
    await expect(resolveWithinRepo(repo, 'link/secret.txt')).rejects.toThrow()
  })
})

describe('readFileCapped (E4 UTF-8 boundary)', () => {
  it('does not emit a replacement char when the cap splits a multibyte codepoint', async () => {
    // '€' is 3 bytes (E2 82 AC). Put one at a boundary so the cap lands mid-char.
    const content = 'abcd€efgh'
    const p = join(repo, 'u.txt')
    await fs.writeFile(p, content, 'utf8')
    // 'abcd' = 4 bytes, then '€' starts at byte 4. Cap at 5 splits the euro sign.
    const out = await readFileCapped(p, 5)
    expect(out.truncated).toBe(true)
    expect(out.content).not.toContain('�')
    expect(out.content).toBe('abcd') // partial codepoint dropped, not mangled
  })

  it('reads a whole small file intact', async () => {
    const p = join(repo, 'whole.txt')
    await fs.writeFile(p, 'héllo €', 'utf8')
    const out = await readFileCapped(p, 1024)
    expect(out.truncated).toBe(false)
    expect(out.content).toBe('héllo €')
  })
})

describe('writeFileSafe EOL handling (E9/E10)', () => {
  it('preserves CRLF for a CRLF-dominant file even with a leading bare \\n', async () => {
    const p = join(repo, 'crlf.txt')
    // Leading bare LF (idx 0), then CRLF lines - majority is CRLF. The old
    // first-newline heuristic wrongly picked LF because idx 0 has no preceding \r.
    await fs.writeFile(p, '\nline1\r\nline2\r\n', 'utf8')
    const stat = await fs.stat(p)
    const res = await writeFileSafe(p, 'a\nb\nc\n', { expectedMtimeMs: stat.mtimeMs })
    expect(res.ok).toBe(true)
    const raw = await fs.readFile(p, 'utf8')
    expect(raw).toBe('a\r\nb\r\nc\r\n')
  })

  it('normalizes a stray lone \\r when writing CRLF', async () => {
    const p = join(repo, 'crlf2.txt')
    await fs.writeFile(p, 'x\r\ny\r\n', 'utf8')
    const stat = await fs.stat(p)
    // Content carries an old-Mac lone \r - must not survive as a stray \r.
    const res = await writeFileSafe(p, 'a\rb\nc\n', { expectedMtimeMs: stat.mtimeMs })
    expect(res.ok).toBe(true)
    const raw = await fs.readFile(p, 'utf8')
    expect(raw).toBe('a\r\nb\r\nc\r\n')
  })
})
