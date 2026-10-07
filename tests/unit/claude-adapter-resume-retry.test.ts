/**
 * A resume that crashes the CLI is retried as a new session. The retry must
 * carry the messages the failed query never answered, or the user's message
 * is stored as sent and the agent never reads it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

type Pushed = { message: { content: unknown } }
const retryReads: Pushed[] = []
let calls = 0
/** Messages the first query answers with a `result` before it reads one more and dies. */
let answeredFirst = 0

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<Pushed>; options: { resume?: string } }) => {
    calls += 1
    const first = calls === 1
    return {
      async *[Symbol.asyncIterator]() {
        const it = args.prompt[Symbol.asyncIterator]()
        if (first) {
          for (let i = 0; i < answeredFirst; i++) {
            await it.next()
            yield { type: 'result', session_id: '11111111-1111-4111-8111-111111111111' }
          }
          // The CLI reads the message, then dies.
          await it.next()
          throw new Error('Claude Code process exited with code 1')
        }
        for (;;) {
          const next = await it.next()
          if (next.done) return
          retryReads.push(next.value)
        }
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      getContextUsage: vi.fn(async () => ({})),
      close: vi.fn(),
    }
  }),
}))

vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

// The transcript is in place, so the query is started with --resume.
vi.mock('../../src/main/provider/claude-session-migrate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/claude-session-migrate')>()
  return { ...actual, ensureClaudeSessionResumable: () => ({ ok: true }) }
})

afterEach(() => {
  retryReads.length = 0
  calls = 0
  answeredFirst = 0
})

describe('Claude resume retry', () => {
  it('sends the unanswered message again to the new session', async () => {
    const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
    const adapter = new ClaudeAdapter()
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, vi.fn())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).sessions.get('t1').session.sessionId = '11111111-1111-4111-8111-111111111111'

    await adapter.sendTurn('t1', 'do the thing', 'sandbox')
    await vi.waitFor(() => expect(retryReads).toHaveLength(1))
    expect(retryReads[0].message.content).toBe('do the thing')
    await adapter.stopSession('t1')
  })

  it('does not send a message the failed query already answered', async () => {
    answeredFirst = 1
    const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
    const adapter = new ClaudeAdapter()
    await adapter.startSession({ threadId: 't2', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, vi.fn())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(adapter as any).sessions.get('t2').session.sessionId = '11111111-1111-4111-8111-111111111111'

    await adapter.sendTurn('t2', 'answered', 'sandbox')
    await vi.waitFor(() => expect(calls).toBe(1))
    await adapter.sendTurn('t2', 'not answered', 'sandbox')
    await vi.waitFor(() => expect(retryReads).toHaveLength(1))
    expect(retryReads.map((m) => m.message.content)).toEqual(['not answered'])
    await adapter.stopSession('t2')
  })
})
