/**
 * Spending a banked Codex reset, against a FAKE `codex app-server` (a small
 * node script speaking JSON-RPC over stdio). Nothing here reaches a real
 * account. Covers the idempotency key's lifecycle: a retry after an unknown
 * outcome reuses the key, a terminal outcome drops it, and the next click
 * mints a new one; and that every outcome is followed by a fresh usage read.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../src/main/db/provider-instances', () => ({
  getProviderInstanceFull: (id: string) => (id.startsWith('codex') ? { id, agentType: 'codex', oauthDir: null, env: {} } : { id, agentType: 'claude-code', oauthDir: null, env: {} }),
}))
vi.mock('../../src/main/provider/usage/claude-keychain', () => ({ forgetClaudeCredentialReads: vi.fn() }))
vi.mock('../../src/main/provider/usage/claude-usage', () => ({ fetchClaudeUsage: vi.fn() }))

const dir = mkdtempSync(join(tmpdir(), 'sb-codex-reset-test-'))
const bin = join(dir, 'codex')
const modeFile = join(dir, 'mode')
const logFile = join(dir, 'log')

vi.mock('../../src/main/provider/adapters/codex-adapter', () => ({ findCodexPath: () => bin }))
vi.mock('../../src/main/provider/instance-env', () => ({
  resolveInstanceEnv: () => ({ PATH: process.env.PATH ?? '', FAKE_MODE_FILE: modeFile, FAKE_LOG_FILE: logFile }),
}))

// Modes: an outcome name answers with it; `exit` dies on consume (no answer);
// `hang-once` stays silent on the first consume and answers `reset` after.
writeFileSync(bin, `#!${process.execPath}
const fs = require('fs')
const readline = require('readline')
const mode = () => fs.readFileSync(process.env.FAKE_MODE_FILE, 'utf8').trim()
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG_FILE, JSON.stringify(entry) + '\\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
let consumes = 0
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') return reply(msg.id, {})
  if (msg.method === 'account/read') return reply(msg.id, { account: { type: 'chatgpt', planType: 'plus' } })
  if (msg.method === 'account/rateLimits/read') {
    log({ method: 'read' })
    return reply(msg.id, {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790000000 } },
      rateLimitResetCredits: { availableCount: 1, credits: null },
    })
  }
  if (msg.method === 'account/rateLimitResetCredit/consume') {
    consumes++
    log({ method: 'consume', params: msg.params })
    const m = mode()
    if (m === 'exit') process.exit(3)
    if (m === 'hang-once' && consumes === 1) return
    return reply(msg.id, { outcome: m === 'hang-once' ? 'reset' : m })
  }
})
`)
chmodSync(bin, 0o755)

const { consumeInstanceReset, hasPendingReset, forgetResetAttempt } = await import('../../src/main/provider/usage')
const { consumeCodexReset, ResetKeyBook } = await import('../../src/main/provider/usage/codex-reset')

function entries(): Array<{ method: string; params?: { idempotencyKey: string; creditId?: string } }> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const consumes = () => entries().filter((e) => e.method === 'consume').map((e) => e.params!)

beforeEach(() => {
  rmSync(logFile, { force: true })
  forgetResetAttempt('codex-a')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ResetKeyBook', () => {
  it('reuses a pending key, drops it on a terminal outcome, then mints a new one', () => {
    let n = 0
    const book = new ResetKeyBook(() => `key-${++n}`)
    const first = book.take('a', 'credit-1')
    book.settle('a', first, 'unknown')
    // A retry keeps the key and the credit it was minted for.
    expect(book.take('a', 'credit-2')).toEqual({ idempotencyKey: 'key-1', creditId: 'credit-1' })
    book.settle('a', first, 'noCredit')
    expect(book.has('a')).toBe(false)
    expect(book.take('a', null).idempotencyKey).toBe('key-2')
    // Keys are per instance.
    expect(book.take('b', null).idempotencyKey).toBe('key-3')
  })
})

describe('consumeCodexReset against a fake app-server', () => {
  const env = () => ({ PATH: process.env.PATH ?? '', FAKE_MODE_FILE: modeFile, FAKE_LOG_FILE: logFile })

  it('sends the key and the credit id, and maps the answer', async () => {
    writeFileSync(modeFile, 'alreadyRedeemed')
    await expect(consumeCodexReset(env(), bin, { idempotencyKey: 'k1', creditId: 'c1' })).resolves.toBe('alreadyRedeemed')
    expect(consumes()).toEqual([{ idempotencyKey: 'k1', creditId: 'c1' }])
  })

  it('leaves creditId out when the list was not known', async () => {
    writeFileSync(modeFile, 'reset')
    await consumeCodexReset(env(), bin, { idempotencyKey: 'k2', creditId: null })
    expect(consumes()).toEqual([{ idempotencyKey: 'k2' }])
  })

  it('retries a timeout once in the same session with the same key', async () => {
    writeFileSync(modeFile, 'hang-once')
    await expect(consumeCodexReset(env(), bin, { idempotencyKey: 'k3', creditId: null }, 500)).resolves.toBe('reset')
    expect(consumes()).toEqual([{ idempotencyKey: 'k3' }, { idempotencyKey: 'k3' }])
  })

  it('answers unknown when the server dies before replying', async () => {
    writeFileSync(modeFile, 'exit')
    await expect(consumeCodexReset(env(), bin, { idempotencyKey: 'k4', creditId: null })).resolves.toBe('unknown')
  })
})

describe('consumeInstanceReset', () => {
  it('reuses the key after an unknown outcome and mints a new one after a terminal one', async () => {
    writeFileSync(modeFile, 'exit')
    const lost = await consumeInstanceReset('codex-a', 'credit-soon')
    expect(lost.outcome).toBe('unknown')
    expect(hasPendingReset('codex-a')).toBe(true)

    writeFileSync(modeFile, 'reset')
    const retried = await consumeInstanceReset('codex-a', 'credit-other')
    expect(retried.outcome).toBe('reset')
    expect(hasPendingReset('codex-a')).toBe(false)

    const again = await consumeInstanceReset('codex-a', null)
    expect(again.outcome).toBe('reset')

    const [first, second, third] = consumes()
    expect(second).toEqual(first)
    expect(first.creditId).toBe('credit-soon')
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(third.creditId).toBeUndefined()
  }, 20_000)

  it('reads usage again after every outcome', async () => {
    for (const outcome of ['nothingToReset', 'noCredit', 'exit']) {
      rmSync(logFile, { force: true })
      writeFileSync(modeFile, outcome)
      const result = await consumeInstanceReset('codex-a', null)
      expect(entries().map((e) => e.method)).toEqual(['consume', 'read'])
      expect(result.usage.status).toBe('ok')
      expect(result.usage.resetCredits).toEqual({ availableCount: 1, credits: null })
    }
  }, 20_000)

  it('joins a second click while one is running', async () => {
    writeFileSync(modeFile, 'reset')
    const [a, b] = await Promise.all([consumeInstanceReset('codex-a', null), consumeInstanceReset('codex-a', null)])
    expect(a).toBe(b)
    expect(consumes()).toHaveLength(1)
  }, 20_000)

  it('refuses a non-Codex account without spawning anything', async () => {
    const result = await consumeInstanceReset('claude-x', null)
    expect(result.outcome).toBe('unknown')
    expect(consumes()).toHaveLength(0)
  })
})
