import { describe, expect, it } from 'vitest'
import { prepareIpcEmit } from '../../src/main/backend/ipc-wire'

describe('prepareIpcEmit', () => {
  it('normalizes emitted arguments through the JSON wire contract', () => {
    const prepared = prepareIpcEmit('provider:event', [{
      type: 'tool.completed',
      threadId: 'thread-1',
      toolId: 'tool-1',
      output: 'done',
      nested: { value: 1 },
    }])

    expect(prepared).toMatchObject({
      ok: true,
      channel: 'provider:event',
      eventType: 'tool.completed',
      threadId: 'thread-1',
    })
    if (prepared.ok) {
      expect(prepared.args).toEqual([{
        type: 'tool.completed',
        threadId: 'thread-1',
        toolId: 'tool-1',
        output: 'done',
        nested: { value: 1 },
      }])
      expect(prepared.bytes).toBeGreaterThan(0)
    }
  })

  it('rejects a non-JSON value before Electron structured clone sees it', () => {
    const prepared = prepareIpcEmit('provider:event', [{
      type: 'tool.completed',
      threadId: 'thread-1',
      output: 1n,
    }])

    expect(prepared).toMatchObject({
      ok: false,
      channel: 'provider:event',
      eventType: 'tool.completed',
      threadId: 'thread-1',
      reason: expect.stringContaining('serializable'),
    })
  })

  it('rejects an oversized emit before Electron structured clone sees it', () => {
    const prepared = prepareIpcEmit('provider:event', [{
      type: 'tool.completed',
      threadId: 'thread-1',
      output: 'x'.repeat(1025),
    }], 1024)

    expect(prepared).toMatchObject({
      ok: false,
      channel: 'provider:event',
      eventType: 'tool.completed',
      threadId: 'thread-1',
      reason: expect.stringContaining('exceeds'),
    })
  })
})
