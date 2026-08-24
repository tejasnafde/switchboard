import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import {
  cloneForkMessages,
  decodeForkMessageRow,
} from '../../src/main/conversations/fork-message-codec'

function richMessages(): ChatMessage[] {
  return [
    {
      id: 'source-image-only',
      role: 'user',
      content: '',
      timestamp: 10,
      images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'screen.png' }],
      context: [{ paneId: 'pane-1', label: 'tests', content: 'FAIL test', cwd: '/repo' }],
      displayBody: '[[pill:file-1]]',
      pillsMeta: { 'file-1': { label: 'README.md', kind: 'file' } },
    },
    {
      id: 'source-assistant',
      role: 'assistant',
      content: 'I inspected it.',
      timestamp: 20,
      toolCalls: [{
        id: 'tool-1',
        name: 'Read',
        input: '{"file_path":"README.md"}',
        output: 'contents',
        state: 'done',
      }],
      plan: { id: 'plan-1', content: '1. Inspect\n2. Repair' },
      todos: { id: 'todos-1', items: [{ text: 'Repair', status: 'in_progress' }] },
      question: {
        requestId: 'question-1',
        questions: [{ question: 'Continue?', header: 'Choice', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }],
        status: 'pending',
      },
      turnDurationMs: 1_250,
    },
    {
      id: 'source-file-diff',
      role: 'assistant',
      content: '',
      timestamp: 30,
      fileDiff: {
        id: 'diff-1',
        repoRoot: '/repo',
        relPath: 'src/main.ts',
        changeKind: 'modify',
        oldContent: 'old',
        newContent: 'new',
        status: 'pending',
      },
      denial: {
        toolName: 'Write',
        reason: 'Plan mode',
        mode: 'plan',
      },
    },
  ]
}

describe('fork rich-message copy codec', () => {
  it('copies every durable field, including image-only and structured messages', () => {
    const source = richMessages()
    const cloned = cloneForkMessages('fork-conversation', source, (index) => `fork-message-${index}`)

    expect(cloned.warnings).toEqual([])
    expect(cloned.messages.map((message) => message.id)).toEqual([
      'fork-message-0',
      'fork-message-1',
      'fork-message-2',
    ])
    expect(cloned.rows).toHaveLength(3)
    expect(cloned.rows[0]).toMatchObject({
      id: 'fork-message-0',
      conversationId: 'fork-conversation',
      content: '',
      imagesJson: expect.stringContaining('screen.png'),
      attachmentsJson: expect.stringContaining('context'),
    })
    expect(cloned.rows.map(decodeForkMessageRow)).toEqual(cloned.messages)
    expect(cloned.messages).toEqual(source.map((message, index) => ({
      ...message,
      id: `fork-message-${index}`,
    })))
  })

  it('preserves deterministic source ordering when timestamps collide', () => {
    const source = [
      { id: 'a', role: 'user', content: 'first', timestamp: 10 },
      { id: 'b', role: 'assistant', content: 'second', timestamp: 10 },
    ] satisfies ChatMessage[]

    expect(cloneForkMessages('fork', source, (index) => `new-${index}`).messages)
      .toEqual([
        { ...source[0], id: 'new-0' },
        { ...source[1], id: 'new-1' },
      ])
  })

  it('returns the exact generated ids that will be persisted', () => {
    const cloned = cloneForkMessages('fork', richMessages(), (index) => `persisted-${index}`)
    expect(cloned.rows.map((row) => row.id)).toEqual(cloned.messages.map((message) => message.id))
  })

  it('rejects duplicate generated ids before persistence', () => {
    expect(() => cloneForkMessages('fork', richMessages(), () => 'duplicate'))
      .toThrow(/duplicate fork message id/i)
  })

  it('preserves an unknown JSON attachment and emits a documented warning', () => {
    const source = {
      id: 'future-message',
      role: 'assistant',
      content: '',
      timestamp: 40,
      futureAttachment: { version: 2, value: 'keep me' },
    } as ChatMessage & { futureAttachment: { version: number; value: string } }

    const cloned = cloneForkMessages('fork', [source], () => 'new-future')

    expect(cloned.warnings).toEqual([{
      code: 'unknown-message-field',
      messageId: 'future-message',
      fields: ['futureAttachment'],
    }])
    expect(cloned.messages[0]).toEqual({ ...source, id: 'new-future' })
    expect(decodeForkMessageRow(cloned.rows[0])).toEqual({ ...source, id: 'new-future' })
  })
})
