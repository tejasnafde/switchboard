/**
 * A query that dies mid-turn sends no `result`, so the adapter must end the
 * running turn itself, or the backend counts it as running until some later
 * turn ends.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      await args.prompt[Symbol.asyncIterator]().next()
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } }
      throw new Error('socket hang up')
    },
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    getContextUsage: vi.fn(async () => ({})),
    close: vi.fn(),
  })),
}))

vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

describe('Claude query crash', () => {
  it('ends the running turn before reporting the error', async () => {
    const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
    const adapter = new ClaudeAdapter()
    const onEvent = vi.fn()
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, onEvent)
    await adapter.sendTurn('t1', 'do the thing', 'sandbox')
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ type: 'status', threadId: 't1', status: 'error' }))
    const types = onEvent.mock.calls.map(([e]) => e.type === 'status' ? `status:${e.status}` : e.type)
    expect(types.filter((t) => t === 'turn.completed')).toHaveLength(1)
    expect(types.indexOf('turn.completed')).toBeLessThan(types.lastIndexOf('status:error'))
    await adapter.stopSession('t1')
  })
})
