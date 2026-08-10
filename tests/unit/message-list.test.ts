import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { groupIntoTurns, roleLabel } from '../../src/renderer/components/chat/MessageList'
import { activitySummaryLabel, projectTurnPresentation } from '../../src/renderer/components/chat/turnPresentation'

/**
 * Regression tests for MessageList.groupIntoTurns.
 *
 * Real bug shipped to main on 2026-04-20: the empty-content filter inside
 * groupIntoTurns dropped any message with `content === ''` that didn't also
 * have toolCalls or an approval attachment. QuestionCard and PlanCard
 * messages have empty content (the UI is in the attachment), so they were
 * silently filtered out before rendering - the message was in the store,
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

  it('keeps assistant messages with a fileDiff attachment (FileDiffCard)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'edit it' }),
      msg({
        role: 'assistant',
        content: '',
        fileDiff: {
          fileEditId: '1:src/a.ts',
          repoRoot: '/repo',
          relPath: 'src/a.ts',
          changeKind: 'modify',
          oldContent: 'old\n',
          newContent: 'new\n',
          status: 'pending',
        },
      }),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1][0].fileDiff?.relPath).toBe('src/a.ts')
  })

  it('keeps system messages that only have a denial (plan-mode block pill)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', content: 'write a file' }),
      msg({
        role: 'system',
        content: '',
        denial: {
          toolName: 'Write',
          reason: 'Plan mode - blocked',
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

  it('keeps assistant messages that only have a todo list', () => {
    const messages = [msg({
      id: 'todos',
      todos: { id: 'list', items: [{ text: 'Ship it', status: 'in_progress' }] },
    })]

    expect(groupIntoTurns(messages)[0]?.[0]).toBe(messages[0])
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

describe('projectTurnPresentation', () => {
  it('formats a restrained tool-and-duration summary', () => {
    expect(activitySummaryLabel(1)).toBe('Used 1 tool')
    expect(activitySummaryLabel(6, 18_000)).toBe('Used 6 tools · 18s')
  })

  it('groups adjacent tool-only activity without hiding conversational content', () => {
    const activityA = msg({ id: 'tool-a', toolCalls: [{ id: 'a', name: 'Read', input: 'a.ts' }] })
    const activityB = msg({ id: 'tool-b', toolCalls: [{ id: 'b', name: 'Bash', input: 'npm test' }] })
    const prose = msg({
      id: 'answer',
      content: 'The tests pass.',
      toolCalls: [{ id: 'c', name: 'Read', input: 'package.json' }],
    })

    const projected = projectTurnPresentation([activityA, activityB, prose])

    expect(projected).toEqual([
      { kind: 'activity', messages: [activityA, activityB], toolCount: 2 },
      { kind: 'message', message: prose },
    ])
  })

  it('groups changed files and preserves every renderable message object exactly once', () => {
    const fileA = msg({ id: 'diff-a', fileDiff: {
      fileEditId: 'turn:a.ts', repoRoot: '/repo', relPath: 'a.ts', changeKind: 'modify',
      oldContent: 'a', newContent: 'b', status: 'pending',
    } })
    const fileB = msg({ id: 'diff-b', fileDiff: {
      fileEditId: 'turn:b.ts', repoRoot: '/repo', relPath: 'b.ts', changeKind: 'add',
      oldContent: '', newContent: 'b', status: 'pending',
    } })
    const approval = msg({ id: 'approval', approval: { toolName: 'Bash', detail: 'npm test', status: 'pending' } })
    const input = [fileA, fileB, approval]

    const projected = projectTurnPresentation(input)
    const output = projected.flatMap((item) => item.kind === 'message' ? [item.message] : item.messages)

    expect(projected[0]).toEqual({ kind: 'files', messages: [fileA, fileB] })
    expect(output).toEqual(input)
    expect(output[0]).toBe(fileA)
    expect(output[1]).toBe(fileB)
    expect(output[2]).toBe(approval)
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
