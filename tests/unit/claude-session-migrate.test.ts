/**
 * `migrateClaudeSession` copies a session JSONL from one CLAUDE_CONFIG_DIR
 * profile to another so the SDK's UUID-based resume keeps working when
 * the user switches between oauth_dir provider instances mid-conversation.
 *
 * Tests run against real tmp directories — pure I/O, no mocks needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateClaudeSession } from '../../src/main/provider/claude-session-migrate'
import { encodeClaudeProjectPath } from '../../src/main/projects/session-scanner'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const CWD = '/Users/tejas/Desktop/projects/example'
const ENCODED = encodeClaudeProjectPath(CWD)

describe('migrateClaudeSession', () => {
  let root: string
  let fromDir: string
  let toDir: string

  function seedSource(content = '{"type":"user","content":"hi"}\n'): string {
    const dir = join(fromDir, 'projects', ENCODED)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${SESSION_ID}.jsonl`)
    writeFileSync(path, content)
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-migrate-'))
    fromDir = join(root, 'from')
    toDir = join(root, 'to')
    mkdirSync(fromDir, { recursive: true })
    mkdirSync(toDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is a no-op when fromDir equals toDir', () => {
    const result = migrateClaudeSession({
      sessionId: SESSION_ID,
      cwd: CWD,
      fromDir,
      toDir: fromDir,
    })
    expect(result).toEqual({ ok: true, copied: false })
  })

  it('returns source-missing when the JSONL is not in the source profile', () => {
    const result = migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    expect(result).toEqual({ ok: false, reason: 'source-missing' })
  })

  it('copies the JSONL into <toDir>/projects/<encodedCwd>/<id>.jsonl', () => {
    const content = '{"type":"user","content":"hello"}\n{"type":"assistant","content":"hi"}\n'
    seedSource(content)

    const result = migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    expect(result).toEqual({ ok: true, copied: true })

    const dstPath = join(toDir, 'projects', ENCODED, `${SESSION_ID}.jsonl`)
    expect(existsSync(dstPath)).toBe(true)
    expect(readFileSync(dstPath, 'utf-8')).toBe(content)
  })

  it('creates intermediate projects/<encodedCwd> dirs in toDir', () => {
    seedSource()
    expect(existsSync(join(toDir, 'projects'))).toBe(false)

    const result = migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    expect(result.ok).toBe(true)
    expect(existsSync(join(toDir, 'projects', ENCODED))).toBe(true)
  })

  it('leaves the source file untouched (rotating back must still work)', () => {
    const srcPath = seedSource()
    migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    expect(existsSync(srcPath)).toBe(true)
  })

  it('is idempotent — second call overwrites with the same content', () => {
    const content = '{"type":"user","content":"hi"}\n'
    seedSource(content)

    const r1 = migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    const r2 = migrateClaudeSession({ sessionId: SESSION_ID, cwd: CWD, fromDir, toDir })
    expect(r1).toEqual({ ok: true, copied: true })
    expect(r2).toEqual({ ok: true, copied: true })

    const dstPath = join(toDir, 'projects', ENCODED, `${SESSION_ID}.jsonl`)
    expect(readFileSync(dstPath, 'utf-8')).toBe(content)
  })
})
