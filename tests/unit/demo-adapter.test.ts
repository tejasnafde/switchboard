import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DemoAdapter, demoAdapters } from '../../src/main/provider/adapters/demo-adapter'
import type { RuntimeEvent } from '@shared/provider-events'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

async function runTurn(mode: 'plan' | 'sandbox', message: string, cwd: string): Promise<RuntimeEvent[]> {
  const adapter = new DemoAdapter('claude')
  const events: RuntimeEvent[] = []
  await adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: mode }, (e) => events.push(e))
  await adapter.sendTurn('t1', message, mode)
  await vi.waitFor(() => {
    if (!events.some((e) => e.type === 'turn.completed')) throw new Error('turn still running')
  }, { timeout: 15_000, interval: 50 })
  return events
}

describe('DemoAdapter (tour recorder script)', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sb-demo-adapter-'))
    mkdirSync(join(cwd, 'src', 'api'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'export async function exchangeCode() {}\n')
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  it('plan mode reads, then emits a denied Write and never touches the tree', async () => {
    const events = await runTurn('plan', 'Refactor the auth callback', cwd)
    const denied = events.filter((e) => e.type === 'tool.denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ toolName: 'Write', mode: 'plan' })
    const started = events.filter((e) => e.type === 'tool.started').map((e) => (e as { toolName: string }).toolName)
    expect(started).toEqual(['Read', 'Read'])
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('exchangeCode() {}')
  }, 20_000)

  it('an edit request rewrites src/api/auth.ts in the session cwd', async () => {
    const events = await runTurn('sandbox', 'Move the state check ahead of the exchange.', cwd)
    expect(events.some((e) => e.type === 'tool.started' && e.toolName === 'Edit')).toBe(true)
    expect(readFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'utf8')).toContain('verifyState(state)')
    expect(events.some((e) => e.type === 'tool.denied')).toBe(false)
  }, 20_000)

  it('streams assistant text as appended deltas under one messageId', async () => {
    const events = await runTurn('sandbox', 'What do the tests cover?', cwd)
    const content = events.filter((e) => e.type === 'content') as Array<{ messageId: string; append?: boolean; text: string }>
    expect(content.length).toBeGreaterThan(3)
    expect(new Set(content.map((c) => c.messageId)).size).toBe(1)
    expect(content[0].append).toBe(false)
    expect(content.slice(1).every((c) => c.append)).toBe(true)
    expect(content.map((c) => c.text).join('')).toMatch(/^Two focused tests/)
  }, 20_000)

  it('reports the scripted duration, identical on every run', async () => {
    const duration = (events: RuntimeEvent[]) => events.find((e) => e.type === 'turn.completed')
    const [first, second] = await Promise.all([
      runTurn('sandbox', 'What do the tests cover?', cwd),
      runTurn('sandbox', 'What do the tests cover?', cwd),
    ])
    expect(duration(first)).toMatchObject({ durationMs: expect.any(Number) })
    expect(duration(first)).toEqual(duration(second))
  }, 20_000)

  it('a run request holds the turn on an approval until it is answered', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e))
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    const opened = await vi.waitFor(() => {
      const event = events.find((e) => e.type === 'request.opened')
      if (!event || event.type !== 'request.opened') throw new Error('no approval yet')
      return event
    }, { timeout: 5_000, interval: 50 })
    expect(opened).toMatchObject({ requestType: 'command', toolName: 'Bash', detail: 'npm test' })
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false)
    await adapter.respondToRequest('t1', opened.requestId, 'approve')
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === 'turn.completed')) throw new Error('turn still running')
    }, { timeout: 10_000, interval: 50 })
    expect(events.some((e) => e.type === 'request.closed' && e.decision === 'approve')).toBe(true)
    expect(events.some((e) => e.type === 'tool.started' && e.toolName === 'Bash')).toBe(true)
  }, 20_000)

  it('interrupting a turn blocked on an approval ends it without completing', async () => {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd, runtimeMode: 'sandbox' }, (e) => events.push(e))
    await adapter.sendTurn('t1', 'Run the auth tests', 'sandbox')
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === 'request.opened')) throw new Error('no approval yet')
    }, { timeout: 5_000, interval: 50 })
    await adapter.interruptTurn('t1')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(events.some((e) => e.type === 'turn.completed')).toBe(false)
    expect(events.some((e) => e.type === 'request.closed')).toBe(false)
  }, 20_000)

  it('exposes one scripted adapter per provider kind', () => {
    const map = demoAdapters()
    expect([...map.keys()].sort()).toEqual(['claude', 'codex', 'opencode'])
    expect(map.get('codex')?.provider).toBe('codex')
  })
})
