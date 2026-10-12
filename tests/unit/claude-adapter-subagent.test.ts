import { describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import type { RuntimeEvent } from '../../src/shared/provider-events'

function session() {
  const onEvent = vi.fn()
  const active = {
    session: { threadId: 'thread-1', sessionId: 'sess', status: 'running' },
    query: null,
    onEvent,
    watchdog: { activity: () => {}, suspend: () => {}, resume: () => {} },
    partialMessageText: new Map<string, string>(),
    currentMessageId: 'msg_parent' as string | null,
    currentReasoningMessageId: null,
  }
  const adapter = new ClaudeAdapter()
  const send = (msg: object) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).handleSDKMessage('thread-1', active, msg)
  const events = () => onEvent.mock.calls.map((c) => c[0] as RuntimeEvent).filter((e) => e.type !== 'status')
  return { active, send, events }
}

describe('Claude subagent messages', () => {
  it('stamps a subagent tool call, its result and its text with the Agent call', () => {
    const { active, send, events } = session()
    send({
      type: 'assistant',
      uuid: 'u1',
      parent_tool_use_id: 'toolu_agent',
      message: {
        content: [
          { type: 'text', text: 'Checking the lockfile.' },
          { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm ls' } },
        ],
      },
    })
    send({
      type: 'user',
      parent_tool_use_id: 'toolu_agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Exit code 1', is_error: true }],
      },
    })
    expect(events()).toEqual([
      {
        type: 'content',
        threadId: 'thread-1',
        messageId: 'sub_u1',
        text: 'Checking the lockfile.',
        streamKind: 'assistant',
        parentToolCallId: 'toolu_agent',
      },
      {
        type: 'tool.started',
        threadId: 'thread-1',
        toolId: 'toolu_bash',
        toolName: 'Bash',
        input: { command: 'npm ls' },
        parentToolCallId: 'toolu_agent',
      },
      {
        type: 'tool.completed',
        threadId: 'thread-1',
        toolId: 'toolu_bash',
        output: 'Exit code 1',
        isError: true,
        parentToolCallId: 'toolu_agent',
      },
    ])
    // The parent's open message is untouched, so its next delta continues it.
    expect(active.currentMessageId).toBe('msg_parent')
  })

  it('leaves the parent agent calls unstamped', () => {
    const { send, events } = session()
    send({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'd' } }] },
    })
    send({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'done' }] },
    })
    const [started, completed] = events()
    expect(started).not.toHaveProperty('parentToolCallId')
    expect(completed).toEqual({ type: 'tool.completed', threadId: 'thread-1', toolId: 'toolu_agent', output: 'done' })
  })

  it('keeps a subagent stream out of the parent message', () => {
    const { active, send, events } = session()
    active.partialMessageText.set('msg_parent', 'Hello')
    send({
      type: 'stream_event',
      parent_tool_use_id: 'toolu_agent',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' from the subagent' } },
    })
    send({ type: 'stream_event', parent_tool_use_id: 'toolu_agent', event: { type: 'content_block_stop' } })
    expect(events()).toEqual([])
    expect(active.partialMessageText.get('msg_parent')).toBe('Hello')
  })
})
