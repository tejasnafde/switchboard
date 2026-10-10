/**
 * Stop on a Claude turn: the query can end with an AbortError, or simply
 * finish, without a `result`. The turn must still end with one
 * `turn.completed`, because that is what makes the registry diff the turn's
 * checkpoint and send its diff cards.
 */
import { describe, expect, it, vi } from 'vitest'

const ending = vi.hoisted(() => ({ kind: 'abort' as 'abort' | 'finish', streaming: false }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
    let release: () => void = () => {}
    const interrupted = new Promise<void>((resolve) => { release = resolve })
    return {
      async *[Symbol.asyncIterator]() {
        await args.prompt[Symbol.asyncIterator]().next()
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } }
        ending.streaming = true
        await interrupted
        if (ending.kind === 'abort') {
          const err = new Error('Claude Code process aborted by user')
          err.name = 'AbortError'
          throw err
        }
      },
      interrupt: vi.fn(async () => release()),
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

async function stopRunningTurn(kind: 'abort' | 'finish'): Promise<string[]> {
  ending.kind = kind
  ending.streaming = false
  const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
  const adapter = new ClaudeAdapter()
  const onEvent = vi.fn()
  await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, onEvent)
  await adapter.sendTurn('t1', 'edit some files', 'sandbox')
  await vi.waitFor(() => expect(ending.streaming).toBe(true))
  await adapter.interruptTurn('t1')
  await vi.waitFor(() => expect(onEvent.mock.calls.at(-1)?.[0]).toEqual({ type: 'status', threadId: 't1', status: 'idle' }))
  await adapter.stopSession('t1')
  return onEvent.mock.calls.map(([e]) => e.type === 'status' ? `status:${e.status}` : e.type)
}

describe('Claude Stop ends the turn', () => {
  it('ends the turn once when the interrupted query throws an AbortError', async () => {
    const types = await stopRunningTurn('abort')
    expect(types.filter((t) => t === 'turn.completed')).toHaveLength(1)
    expect(types.indexOf('turn.completed')).toBeLessThan(types.lastIndexOf('status:idle'))
    expect(types).not.toContain('error')
  })

  it('ends the turn once when the interrupted query finishes with no result', async () => {
    const types = await stopRunningTurn('finish')
    expect(types.filter((t) => t === 'turn.completed')).toHaveLength(1)
    expect(types.indexOf('turn.completed')).toBeLessThan(types.lastIndexOf('status:idle'))
  })
})
