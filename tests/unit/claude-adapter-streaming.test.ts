import { describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { TurnWatchdog } from '../../src/main/provider/turn-watchdog'

describe('ClaudeAdapter partial streaming', () => {
  it('ships SDK text deltas as increments, and still accumulates internally for turn assembly', () => {
    const adapter = new ClaudeAdapter() as any
    const onEvent = vi.fn()
    const active = {
      session: { status: 'running' },
      onEvent,
      currentMessageId: null,
      currentReasoningMessageId: null,
      partialMessageText: new Map<string, string>(),
      watchdog: new TurnWatchdog(180_000, () => {}),
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

    const chunks = onEvent.mock.calls.map(([e]) => e).filter((e) => e?.type === 'content')
    const messageId = chunks[0]?.messageId
    expect(messageId).toBeTruthy()
    // The wire carries only what is new.
    expect(chunks.map((c) => c.text)).toEqual(['Hello ', 'from Claude'])
    expect(chunks.every((c) => c.append === true && c.messageId === messageId)).toBe(true)
    // The adapter still holds the whole body: turn assembly and the JSONL
    // fallback both read partialMessageText, so dropping it would empty replies
    // that never reach the streaming path.
    expect(active.partialMessageText.get(messageId)).toBe('Hello from Claude')
  })
})
