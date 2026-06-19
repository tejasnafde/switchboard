import { describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'

describe('ClaudeAdapter partial streaming', () => {
  it('maps SDK stream_event text deltas to accumulated content events', () => {
    const adapter = new ClaudeAdapter() as any
    const onEvent = vi.fn()
    const active = {
      session: { status: 'running' },
      onEvent,
      currentMessageId: null,
      currentReasoningMessageId: null,
      partialMessageText: new Map<string, string>(),
    }

    adapter.handleSDKMessage('thread-1', active, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    })
    adapter.handleSDKMessage('thread-1', active, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'from Claude' },
      },
    })

    const first = onEvent.mock.calls.find((call) => call[0]?.type === 'content')?.[0]
    expect(first?.messageId).toBeTruthy()
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'content',
      threadId: 'thread-1',
      messageId: first.messageId,
      text: 'Hello from Claude',
      streamKind: 'assistant',
    }))
  })
})
