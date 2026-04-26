import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { groupIntoTurns, roleLabel } from '../../src/renderer/components/chat/MessageList'

/**
 * Regression tests for MessageList.groupIntoTurns.
 *
 * Real bug shipped to main on 2026-04-20: the empty-content filter inside
 * groupIntoTurns dropped any message with `content === ''` that didn't also
 * have toolCalls or an approval attachment. QuestionCard and PlanCard
 * messages have empty content (the UI is in the attachment), so they were
 * silently filtered out before rendering — the message was in the store,
 * just invisible.
 *
 * Attachments that MUST keep a message alive:
 *   - toolCalls   (ToolCallBlock)
 *   - approval    (ApprovalCard)
 *   - question    (QuestionCard)  ← regressed
 *   - plan        (PlanCard)      ← regressed
 *   - images      (user image-only message) ← regressed
 */

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    role: partial.role ?? 'assistant',
    content: partial.content ?? '',
    timestamp: partial.timestamp ?? Date.now(),
    ...partial,
  }
}

describe('groupIntoTurns', () => {
  it('drops truly-empty messages (no content, no attachments)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: '' }), // truly empty
      msg({ role: 'user', content: 'hello?' }),
    ]
    const groups = groupIntoTurns(messages)
    // Empty assistant message skipped → the two user messages group into
    // a single turn because they're now consecutive.
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(2)
    expect(groups[0][0].content).toBe('hi')
    expect(groups[0][1].content).toBe('hello?')
  })

  it('keeps assistant messages with toolCalls even if content is empty', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'run ls' }),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'Bash', input: 'ls' }],
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].toolCalls).toBeDefined()
  })

  it('keeps assistant messages with approval (ApprovalCard) even if empty', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'do it' }),
      msg({
        role: 'assistant',
        content: '',
        approval: { toolName: 'Write', detail: '{}', status: 'pending' },
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].approval?.status).toBe('pending')
  })

  // ── The regressed cases ─────────────────────────────────────────

  it('keeps assistant messages with question attachment (QuestionCard)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'ask me' }),
      msg({
        role: 'assistant',
        content: '',
        question: {
          requestId: 'q1',
          status: 'pending',
          questions: [
            {
              id: 'q1.0',
              header: 'Choose',
              question: 'Pick one',
              options: [{ label: 'A' }, { label: 'B' }],
              multiSelect: false,
            },
          ],
        },
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].question?.requestId).toBe('q1')
  })

  it('keeps assistant messages with plan attachment (PlanCard)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'plan it' }),
      msg({
        role: 'assistant',
        content: '',
        plan: { id: 'plan_1', markdown: '# Plan\n- step 1' },
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].plan?.id).toBe('plan_1')
  })

  it('keeps system messages that only have a denial (plan-mode block pill)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'write a file' }),
      msg({
        role: 'system',
        content: '',
        denial: {
          toolName: 'Write',
          reason: 'Plan mode — blocked',
          mode: 'plan',
        },
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].denial?.toolName).toBe('Write')
    expect(groups[1][0].denial?.mode).toBe('plan')
  })

  it('keeps user messages that only have images (no text)', () => {
    const messages: ChatMessage[] = [
      msg({
        role: 'user',
        content: '',
        images: [{ url: 'data:image/png;base64,xyz', mimeType: 'image/png' }],
      }),
      msg({ role: 'assistant', content: 'got your image' }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0][0].images).toHaveLength(1)
    expect(groups[1][0].content).toBe('got your image')
  })

  it('groups consecutive assistant messages into a single turn', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'hi' }),
      msg({ role: 'assistant', content: 'hello' }),
      msg({ role: 'assistant', content: 'here is more' }),
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't', name: 'Read', input: '' }],
      }),
      msg({ role: 'user', content: 'ok' }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(3)
    expect(groups[0][0].role).toBe('user')
    expect(groups[1]).toHaveLength(3) // three consecutive assistant messages
    expect(groups[2][0].role).toBe('user')
  })

  it('handles an empty input without throwing', () => {
    expect(groupIntoTurns([])).toEqual([])
  })

  it('handles all-empty messages and returns empty groups', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'assistant', content: '' }),
      msg({ role: 'assistant', content: '' }),
    ]
    expect(groupIntoTurns(messages)).toEqual([])
  })
})

describe('roleLabel', () => {
  it('labels assistant turns by the active provider', () => {
    expect(roleLabel('assistant', 'claude-code')).toBe('Claude')
    expect(roleLabel('assistant', 'codex')).toBe('Codex')
  })

  it('keeps user and system labels provider-neutral', () => {
    expect(roleLabel('user', 'codex')).toBe('You')
    expect(roleLabel('system', 'codex')).toBe('System')
  })
})
