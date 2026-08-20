import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  ensureCodexSessionResumable,
  prepareCodexProfileSwitch,
} from '../../src/main/provider/codex-session-migrate'

const SESSION_ID = '019c7a41-a8b2-73f0-a7d6-b3f56d8db92f'
const scratch: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-codex-migrate-'))
  scratch.push(root)
  return root
}

function seedRollout(
  codexHome: string,
  body: string,
  options: { sessionId?: string; day?: string; mtimeMs?: number } = {},
): string {
  const sessionId = options.sessionId ?? SESSION_ID
  const day = options.day ?? '20'
  const path = join(
    codexHome,
    'sessions',
    '2026',
    '08',
    day,
    `rollout-2026-08-${day}T10-00-00-${sessionId}.jsonl`,
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/repo', source: 'exec', originator: 'codex_exec' },
    })}\n${body}`,
  )
  if (options.mtimeMs != null) {
    const at = new Date(options.mtimeMs)
    utimesSync(path, at, at)
  }
  return path
}

afterEach(() => {
  while (scratch.length > 0) {
    rmSync(scratch.pop()!, { recursive: true, force: true })
  }
})

describe('ensureCodexSessionResumable', () => {
  it('copies a matching rollout into the exact target CODEX_HOME without moving the source', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'codex-work')
    const targetHome = join(root, 'codex-personal')
    const sourcePath = seedRollout(sourceHome, 'complete transcript\n')

    const result = await ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: targetHome,
      candidates: [sourceHome, targetHome],
    })

    expect(result).toMatchObject({ ok: true, copied: true, sourcePath })
    if (!result.ok) throw new Error('expected migration success')
    const targetRelativePath = relative(targetHome, result.targetPath)
    expect(
      targetRelativePath === 'sessions' || targetRelativePath.startsWith(`sessions${sep}`),
    ).toBe(true)
    expect(readFileSync(result.targetPath, 'utf8')).toBe(readFileSync(sourcePath, 'utf8'))
    expect(existsSync(sourcePath)).toBe(true)
  })

  it('prefers the most complete append-only rollout over a newer truncated copy', async () => {
    const root = tempRoot()
    const completeHome = join(root, 'complete')
    const truncatedHome = join(root, 'truncated')
    const targetHome = join(root, 'target')
    const complete = seedRollout(completeHome, 'turn\n'.repeat(50), { mtimeMs: 1_000 })
    seedRollout(truncatedHome, 'turn\n', { day: '21', mtimeMs: 2_000 })

    const result = await ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: targetHome,
      candidates: [completeHome, truncatedHome, targetHome],
    })

    expect(result).toMatchObject({ ok: true, copied: true, sourcePath: complete })
  })

  it('does not overwrite or downgrade a target copy that is already at least as complete', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    seedRollout(sourceHome, 'old\n', { mtimeMs: 1_000 })
    const target = seedRollout(targetHome, 'new\n'.repeat(40), { day: '22', mtimeMs: 2_000 })
    const before = readFileSync(target, 'utf8')

    const result = await ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: targetHome,
      candidates: [sourceHome, targetHome],
    })

    expect(result).toEqual({ ok: true, copied: false, sourcePath: target, targetPath: target })
    expect(readFileSync(target, 'utf8')).toBe(before)
  })

  it('upgrades a stale target copy with the freshest matching rollout', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    const source = seedRollout(sourceHome, 'full\n'.repeat(40), { mtimeMs: 2_000 })
    const target = seedRollout(targetHome, 'short\n', { day: '22', mtimeMs: 1_000 })

    const result = await ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: targetHome,
      candidates: [sourceHome, targetHome],
    })

    expect(result).toEqual({ ok: true, copied: true, sourcePath: source, targetPath: target })
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'))
  })

  it('returns source-missing when no candidate contains the requested session', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    seedRollout(sourceHome, 'different\n', { sessionId: 'different-session' })

    await expect(ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: join(root, 'target'),
      candidates: [sourceHome],
    })).resolves.toEqual({ ok: false, reason: 'source-missing' })
  })

  it('returns a typed io-error instead of throwing when the target cannot be created', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target-file')
    seedRollout(sourceHome, 'complete\n')
    writeFileSync(targetHome, 'not a directory')

    const result = await ensureCodexSessionResumable({
      sessionId: SESSION_ID,
      toDir: targetHome,
      candidates: [sourceHome],
    })

    expect(result).toMatchObject({ ok: false, reason: 'io-error' })
    if (result.ok || result.reason !== 'io-error') throw new Error('expected typed io failure')
    expect(result.detail).toMatch(/directory|ENOTDIR|EEXIST/i)
    expect(statSync(targetHome).isFile()).toBe(true)
  })
})

describe('prepareCodexProfileSwitch', () => {
  it('classifies multiple source rollouts as a context conflict', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    seedRollout(sourceHome, `${JSON.stringify({ type: 'response_item', payload: { role: 'user' } })}\n`, { day: '20' })
    seedRollout(sourceHome, `${JSON.stringify({ type: 'response_item', payload: { role: 'assistant' } })}\n`, { day: '21' })

    const result = await prepareCodexProfileSwitch({
      sessionId: SESSION_ID,
      fromDir: sourceHome,
      toDir: join(root, 'target'),
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'context-conflict',
      detail: expect.stringContaining('multiple rollouts'),
    })
  })

  const first = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'one' } })}\n`
  const second = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'two' } })}\n`

  it('advances the selected target rollout from the stopped source home', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    const sourcePath = seedRollout(sourceHome, first + second)
    const targetPath = seedRollout(targetHome, first)

    const result = await prepareCodexProfileSwitch({
      sessionId: SESSION_ID,
      fromDir: sourceHome,
      toDir: targetHome,
    })

    expect(result).toEqual({
      ok: true,
      copied: true,
      compatibility: 'target-prefix',
      sourcePath,
      targetPath,
    })
    expect(readFileSync(targetPath, 'utf8')).toBe(readFileSync(sourcePath, 'utf8'))
  })

  it('refuses divergent rollouts without overwriting either profile', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    const targetHome = join(root, 'target')
    const sourcePath = seedRollout(sourceHome, first + `${JSON.stringify({ source: true })}\n`)
    const targetPath = seedRollout(targetHome, first + `${JSON.stringify({ target: true })}\n`)

    const result = await prepareCodexProfileSwitch({
      sessionId: SESSION_ID,
      fromDir: sourceHome,
      toDir: targetHome,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'context-conflict',
      sourcePath,
      targetPath,
    })
    expect(readFileSync(sourcePath, 'utf8')).toContain('source')
    expect(readFileSync(targetPath, 'utf8')).toContain('target')
  })
})
