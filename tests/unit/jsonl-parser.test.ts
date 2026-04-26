import { describe, it, expect, vi } from 'vitest'
import { JsonlParser } from '../../src/main/agent/jsonl-parser'

describe('JsonlParser', () => {
  it('parses a complete assistant message', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'assistant',
      id: 'msg_1',
      message: {
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'msg_1',
      role: 'assistant',
      content: 'Hello, world!',
    })
  })

  it('parses a user message', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      message: { content: 'How do I fix this?' },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'How do I fix this?',
    })
  })

  it('extracts tool calls from assistant messages', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'Read',
            input: { file_path: '/src/index.ts' },
          },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Let me read that file.')
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls[0]).toMatchObject({
      id: 'tool_1',
      name: 'Read',
    })
  })

  it('handles partial lines across chunks', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    const full = JSON.stringify({ type: 'assistant', message: { content: 'partial' } })
    const half = Math.floor(full.length / 2)

    parser.feed(full.slice(0, half))
    expect(messages).toHaveLength(0)

    parser.feed(full.slice(half) + '\n')
    expect(messages).toHaveLength(1)
  })

  it('handles multiple messages in one chunk', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    const line1 = JSON.stringify({ type: 'user', message: { content: 'first' } })
    const line2 = JSON.stringify({ type: 'user', message: { content: 'second' } })

    parser.feed(line1 + '\n' + line2 + '\n')
    expect(messages).toHaveLength(2)
  })

  it('skips non-JSON lines gracefully', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed('not json at all\n')
    parser.feed('{ invalid json\n')
    expect(messages).toHaveLength(0)
  })

  it('skips unknown event types', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({ type: 'unknown_event', data: {} }) + '\n')
    expect(messages).toHaveLength(0)
  })

  it('flushes buffered partial line', () => {
    const messages: unknown[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    // Feed without trailing newline
    parser.feed(JSON.stringify({ type: 'result', result: 'done' }))
    expect(messages).toHaveLength(0)

    parser.flush()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'done',
    })
  })

  it('handles string content format', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'assistant',
      message: { content: 'plain string content' },
    }) + '\n')

    expect(messages[0].content).toBe('plain string content')
  })

  // ── Real Claude Code JSONL format tests ──────────────────────────

  it('parses real Claude Code user message format', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    // This is the actual format from ~/.claude/projects/*/session.jsonl
    parser.feed(JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: 'cb2b7d28-0161-48ef-bcd1-1e4900f4f68d',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'explain this code' }],
      },
      uuid: '321ddcbf-dd99-485b-ade5-985619970183',
      timestamp: '2026-04-11T18:38:58.516Z',
      sessionId: '017eb80a-4f68-4132-affe-4629d124725b',
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('explain this code')
  })

  it('parses real Claude Code assistant message with text content', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      parentUuid: '321ddcbf-dd99-485b-ade5-985619970183',
      isSidechain: false,
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        id: 'msg_01ABC',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is the explanation.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      uuid: '3edbb8e2-7c6d-4872-b0a6-0a668112fce2',
      timestamp: '2026-04-11T18:39:02.568Z',
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].content).toBe('Here is the explanation.')
  })

  it('parses real Claude Code assistant message with tool_use', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        id: 'msg_01XYZ',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01T1', name: 'Bash', input: { command: 'ls -la' } },
        ],
      },
      uuid: 'abc-123',
      timestamp: '2026-04-11T18:39:05.000Z',
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].toolCalls).toHaveLength(1)
    expect(messages[0].toolCalls[0].name).toBe('Bash')
  })

  it('skips non-message event types from real JSONL', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    // These types appear in real JSONL but are not messages
    const nonMessageEvents = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-04-11T18:38:58.390Z' },
      { type: 'file-history-snapshot', messageId: 'abc', snapshot: {} },
      { type: 'ai-title', sessionId: 'abc', aiTitle: 'Some title' },
      { type: 'tool_result', messageId: 'abc' },
      { type: 'system', sessionId: 'abc' },
    ]

    for (const event of nonMessageEvents) {
      parser.feed(JSON.stringify(event) + '\n')
    }

    expect(messages).toHaveLength(0)
  })

  it('parses a full real session with mixed event types', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    const lines = [
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'queue-operation', operation: 'dequeue' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, uuid: 'u1', timestamp: '2026-04-11T18:38:58.516Z' },
      { type: 'file-history-snapshot', messageId: 'u1', snapshot: {} },
      { type: 'ai-title', sessionId: 'abc', aiTitle: 'Greeting' },
      { type: 'assistant', message: { id: 'msg_01', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }, uuid: 'a1' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'thanks' }] }, uuid: 'u2' },
      { type: 'assistant', message: { id: 'msg_02', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'You are welcome.' }] }, uuid: 'a2' },
    ]

    const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    parser.feed(raw)

    expect(messages).toHaveLength(4)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('hello')
    expect(messages[1].role).toBe('assistant')
    expect(messages[1].content).toBe('Hi there!')
    expect(messages[2].role).toBe('user')
    expect(messages[2].content).toBe('thanks')
    expect(messages[3].role).toBe('assistant')
    expect(messages[3].content).toBe('You are welcome.')
  })

  it('skips user messages that only contain tool_result blocks', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    // This is how Claude Code sends tool results — as user messages with tool_result content
    parser.feed(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01ABC', content: 'file contents here...' },
        ],
      },
      uuid: 'tool-result-1',
    }) + '\n')

    // Should be skipped — not a real user message
    expect(messages).toHaveLength(0)
  })

  it('keeps user messages that have text content alongside tool_result', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the output:' },
          { type: 'tool_result', tool_use_id: 'toolu_01ABC', content: 'some result' },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Here is the output:')
  })

  it('skips assistant messages with no text and no tool calls', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    // Assistant message with only a thinking block — no visible content
    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(0)
  })

  it('extracts thinking blocks from assistant messages', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    // Text content should only include text blocks, not thinking
    expect(messages[0].content).toBe('Here is my answer.')
  })
})

/**
 * Historical-image regression tests (A4).
 *
 * Shipped bug (2026-04-20): images attached in Switchboard were saved to DB
 * and showed correctly in-session, but disappeared on app relaunch because
 * the JSONL parser dropped `image` content blocks when extracting text-only
 * content. Now user messages reconstruct MessageImage[] from Claude's
 * image blocks.
 */
describe('JsonlParser — image extraction', () => {
  it('extracts base64 images from a user message content array', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      id: 'user_1',
      message: {
        content: [
          { type: 'text', text: 'check this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw...' },
          },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('check this')
    expect(messages[0].images).toHaveLength(1)
    expect(messages[0].images[0].url).toBe('data:image/png;base64,iVBORw...')
    expect(messages[0].images[0].mimeType).toBe('image/png')
  })

  it('keeps image-only user messages (no text)', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'XXX' },
          },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].images).toHaveLength(1)
    expect(messages[0].images[0].mimeType).toBe('image/jpeg')
  })

  it('handles URL-sourced images', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/pic.png' },
          },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].images?.[0].url).toBe('https://example.com/pic.png')
  })

  it('still drops tool-result-only user messages', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg))

    parser.feed(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }],
      },
    }) + '\n')

    expect(messages).toHaveLength(0)
  })
})

/**
 * Codex source regression tests.
 *
 * Shipped bug (2026-04-20): imported Codex sessions had titles but zero
 * messages because JsonlParser only recognized Claude's `assistant`/`user`
 * event types. Codex uses `response_item` with `payload.{type,role,content}`.
 * The source param on the parser now routes to a Codex-specific normalizer.
 */
describe('JsonlParser — Codex source', () => {
  it('parses a Codex assistant response_item', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed(JSON.stringify({
      timestamp: '2026-02-03T08:04:55.675Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Got it — here is my plan.' }],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    expect(messages[0].content).toBe('Got it — here is my plan.')
    // ISO timestamp should be parsed
    expect(messages[0].timestamp).toBe(Date.parse('2026-02-03T08:04:55.675Z'))
  })

  it('parses a Codex user response_item with input_text', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Help me refactor this.' }],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('Help me refactor this.')
  })

  it('skips developer-role messages (system prompt / AGENTS.md context)', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions>...</permissions>' }],
      },
    }) + '\n')

    expect(messages).toHaveLength(0)
  })

  it('skips non-response_item events (session_meta, turn_context, event_msg)', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed([
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
      JSON.stringify({ type: 'turn_context', payload: {} }),
      JSON.stringify({ type: 'event_msg', payload: { kind: 'task_started' } }),
    ].join('\n') + '\n')

    expect(messages).toHaveLength(0)
  })

  it('joins multiple text blocks in a single message', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Part 1' },
          { type: 'output_text', text: 'Part 2' },
        ],
      },
    }) + '\n')

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Part 1\nPart 2')
  })

  it('round-trips a realistic Codex session (metadata + user + assistant + metadata)', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')

    parser.feed([
      JSON.stringify({ type: 'session_meta', payload: { id: 's' } }),
      JSON.stringify({ type: 'turn_context', payload: {} }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'IGNORE ME' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { kind: 'turn_completed' } }),
    ].join('\n') + '\n')

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'hello' })
  })

  it('ignores empty-content response_items', () => {
    const messages: any[] = []
    const parser = new JsonlParser((msg) => messages.push(msg), 'codex')
    parser.feed(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [] },
    }) + '\n')
    expect(messages).toHaveLength(0)
  })
})
