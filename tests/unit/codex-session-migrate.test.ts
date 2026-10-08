import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareCodexProfileSwitch } from '../../src/main/provider/codex-session-migrate'

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
  const path = join(codexHome, 'sessions', '2026', '08', day, `rollout-2026-08-${day}T10-00-00-${sessionId}.jsonl`)
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

describe('prepareCodexProfileSwitch', () => {
  it('classifies multiple source rollouts as a context conflict', async () => {
    const root = tempRoot()
    const sourceHome = join(root, 'source')
    seedRollout(sourceHome, `${JSON.stringify({ type: 'response_item', payload: { role: 'user' } })}\n`, { day: '20' })
    seedRollout(sourceHome, `${JSON.stringify({ type: 'response_item', payload: { role: 'assistant' } })}\n`, {
      day: '21',
    })

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
