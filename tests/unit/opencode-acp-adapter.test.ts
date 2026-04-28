import { describe, it, expect } from 'vitest'
import {
  mapSessionUpdate,
  mapAvailableCommands,
  pickPermissionOptions,
  parseImageInput,
} from '../../src/main/provider/adapters/opencode-acp-adapter'

/**
 * Pure event-mapping tests for the OpenCode ACP adapter. The adapter's
 * RPC plumbing is integration-level; these tests pin the wire→RuntimeEvent
 * translator so we can refactor the SDK glue without breaking the
 * renderer's contract.
 */

const tid = 't1'

describe('mapSessionUpdate', () => {
  it('maps agent_message_chunk → content (assistant)', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hello' },
      },
    } as any)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'content',
      threadId: tid,
      messageId: 'm1',
      text: 'hello',
      streamKind: 'assistant',
    })
  })

  it('maps agent_thought_chunk → content (reasoning)', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'm2',
        content: { type: 'text', text: 'thinking…' },
      },
    } as any)
    expect(events[0]).toMatchObject({ streamKind: 'reasoning', text: 'thinking…' })
  })

  it('skips empty content chunks', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm3',
        content: { type: 'text', text: '' },
      },
    } as any)
    expect(events).toHaveLength(0)
  })

  it('maps tool_call → tool.started', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't_001',
        title: 'Read',
        kind: 'read',
        rawInput: { path: '/x.txt' },
      },
    } as any)
    expect(events[0]).toMatchObject({
      type: 'tool.started',
      toolId: 't_001',
      toolName: 'Read',
      input: { path: '/x.txt' },
    })
  })

  it('emits tool.completed only on terminal status', () => {
    const inProg = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't_001', status: 'in_progress' },
    } as any)
    expect(inProg).toHaveLength(0)

    const done = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't_001',
        status: 'completed',
        rawOutput: 'ok',
      },
    } as any)
    expect(done[0]).toMatchObject({ type: 'tool.completed', toolId: 't_001', output: 'ok' })
  })

  it('maps usage_update with cost → context_window with costUsd', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'usage_update',
        used: 1234,
        size: 200000,
        cost: { amount: 0.0123, currency: 'USD' },
      },
    } as any)
    expect(events[0]).toMatchObject({
      type: 'context_window',
      usedTokens: 1234,
      maxTokens: 200000,
      costUsd: 0.0123,
    })
  })

  it('maps plan → plan.proposed with checkbox markdown', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'pending' },
        ],
      },
    } as any)
    expect(events[0]).toMatchObject({ type: 'plan.proposed' })
    expect((events[0] as any).planMarkdown).toContain('- [x] first')
    expect((events[0] as any).planMarkdown).toContain('- [ ] second')
  })

  it('quietly consumes available_commands_update (cached, not forwarded)', () => {
    const events = mapSessionUpdate(tid, {
      sessionId: 's1',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    } as any)
    expect(events).toHaveLength(0)
  })
})

describe('mapAvailableCommands', () => {
  it('strips leading slashes and dedupes by lowercase name', () => {
    const skills = mapAvailableCommands([
      { name: '/build', description: 'build' },
      { name: 'build', description: 'dup' },
      { name: '/test', description: 't' },
    ] as any)
    expect(skills.map((s) => s.name)).toEqual(['build', 'test'])
    expect(skills[0]).toMatchObject({ source: 'opencode' })
  })

  it('omits description when missing', () => {
    const skills = mapAvailableCommands([{ name: 'foo' }] as any)
    expect(skills[0]).toEqual({ name: 'foo', source: 'opencode' })
  })
})

describe('pickPermissionOptions', () => {
  it('picks the first allow-class option and the reject_once option', () => {
    const { allow, reject } = pickPermissionOptions([
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
    ] as any)
    expect(allow).toBe('a1')
    expect(reject).toBe('r1')
  })

  it('falls back to first/last when kinds are not tagged', () => {
    const { allow, reject } = pickPermissionOptions([
      { optionId: 'one', name: 'one' },
      { optionId: 'two', name: 'two' },
    ] as any)
    expect(allow).toBe('one')
    expect(reject).toBe('two')
  })
})

describe('parseImageInput', () => {
  it('strips the data: URL prefix and returns base64 + mime', () => {
    const out = parseImageInput({
      url: 'data:image/png;base64,iVBORw0KGgoAAAANS',
    })
    expect(out.mimeType).toBe('image/png')
    expect(out.data).toBe('iVBORw0KGgoAAAANS')
  })

  it('infers mimeType from the data URL even when one is provided', () => {
    // The data URL is canonical — its embedded mime trumps the prop, since
    // browsers may have re-encoded the image during paste.
    const out = parseImageInput({ url: 'data:image/png;base64,QUJD', mimeType: 'image/jpeg' })
    expect(out.mimeType).toBe('image/png')
    expect(out.data).toBe('QUJD')
  })

  it('returns null data for non-data URLs', () => {
    const out = parseImageInput({ url: 'https://example.com/x.png' })
    expect(out.data).toBeNull()
  })
})
