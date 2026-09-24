import { describe, expect, it, vi } from 'vitest'
import { DemoAdapter } from '../../src/main/provider/adapters/demo-adapter'
import type { RuntimeEvent } from '../../src/shared/provider-events'

// The e2e suite drives queue controls through this adapter, so it must keep
// the same event contract as the real ones.
describe('DemoAdapter queued messages', () => {
  async function running() {
    const adapter = new DemoAdapter('claude')
    const events: RuntimeEvent[] = []
    await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp' }, (e) => events.push(e))
    // "run" holds its turn open on an approval.
    await adapter.sendTurn('t1', 'run the tests')
    return { adapter, events }
  }

  it('holds a queued message behind the running script, then cancels it', async () => {
    const { adapter, events } = await running()
    await adapter.sendTurn('t1', 'later', undefined, undefined, 'queue', 'remote_q1')
    expect(events).toContainEqual({ type: 'turn.queued', threadId: 't1', messageId: 'remote_q1' })
    await expect(adapter.cancelQueuedTurn('t1', 'remote_q1')).resolves.toBe(true)
    await expect(adapter.cancelQueuedTurn('t1', 'remote_q1')).resolves.toBe(false)
    expect(events).toContainEqual({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_q1', reason: 'cancelled' })
    await adapter.stopSession('t1')
  })

  it('promotes one to run beside the script, and drops the rest on stop', async () => {
    const { adapter, events } = await running()
    await adapter.sendTurn('t1', 'now', undefined, undefined, 'queue', 'remote_q1')
    await adapter.sendTurn('t1', 'never', undefined, undefined, 'queue', 'remote_q2')
    await expect(adapter.promoteQueuedTurn('t1', 'remote_q1')).resolves.toBe(true)
    expect(events).toContainEqual({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_q1', reason: 'promoted' })
    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn.completed')).toBe(true), { timeout: 10_000 })
    await adapter.stopSession('t1')
    expect(events).toContainEqual({ type: 'turn.dequeued', threadId: 't1', messageId: 'remote_q2', reason: 'dropped' })
  })
})
