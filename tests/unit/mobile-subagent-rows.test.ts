import { describe, expect, it } from 'vitest'
import { flushQueue, resetQueue, threadKey, useChatStore, type FeedItem } from '../../apps/mobile/src/stores/chat'
import { historyToItems } from '../../apps/mobile/src/lib/thread-history'
import { collapseSubagents, feedToolId, type SubagentRow } from '../../apps/mobile/src/lib/subagent-rows'
import type { ChatMessage } from '../../src/shared/types'

const tool = (id: string, toolName: string, extra: Partial<Extract<FeedItem, { kind: 'tool' }>> = {}): FeedItem => ({
  kind: 'tool',
  id: `t-${id}`,
  toolName,
  input: {},
  state: 'done',
  output: 'ok',
  ...extra,
})

describe('collapseSubagents (Expo)', () => {
  it('folds two parallel subagents into one row each, in place', () => {
    const rows = collapseSubagents([
      { kind: 'user', id: 'u', text: 'Fix it', at: 0 },
      tool('A1', 'Agent', { output: undefined, state: 'running', input: { description: 'Lockfile' } }),
      tool('A2', 'Task', { output: undefined, state: 'running', input: { description: 'Mobile audit' } }),
      tool('x1', 'Grep', { parentToolCallId: 'A1' }),
      tool('y1', 'Read', { parentToolCallId: 'A2' }),
      tool('x2', 'Bash', {
        parentToolCallId: 'A1',
        output: undefined,
        state: 'running',
        input: { command: 'npx vitest' },
      }),
      {
        kind: 'synthetic',
        id: 'n1',
        part: {
          kind: 'task-notification',
          status: 'completed',
          summary: 'Background command "make" completed',
          toolUseId: 'x1',
        },
      },
    ])
    expect(rows.map((row) => row.kind)).toEqual(['user', 'subagent', 'subagent'])
    const [a1, a2] = rows.slice(1) as SubagentRow[]
    expect(a1.view.description).toBe('Lockfile')
    expect(a1.view.stepCount).toBe(3)
    expect(a1.view.currentStep).toBe('make')
    expect([...a1.stepRows.keys()]).toEqual(['t-x1', 't-x2', 'n1'])
    expect(a2.view.stepCount).toBe(1)
  })

  it('leaves the steps of an older backend where they were', () => {
    const rows = collapseSubagents([tool('A', 'Agent', { output: 'done' }), tool('s1', 'Bash')])
    expect(rows.map((row) => row.kind)).toEqual(['subagent', 'tool'])
    expect((rows[0] as SubagentRow).view.status).toBe('done')
  })

  it('reads the provider tool id from live and history rows', () => {
    expect(feedToolId(tool('toolu_1', 'Bash') as Extract<FeedItem, { kind: 'tool' }>)).toBe('toolu_1')
    expect(feedToolId({ ...(tool('x', 'Bash') as Extract<FeedItem, { kind: 'tool' }>), id: 'h-msg-1-t-toolu_2' })).toBe(
      'toolu_2',
    )
  })
})

describe('subagent fields on the phone', () => {
  it('maps a stored step and its error onto the history row', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        timestamp: 5,
        toolCalls: [
          { id: 'b', name: 'Bash', input: '{}', output: 'Exit code 1', isError: true, parentToolCallId: 'A' },
        ],
      },
    ]
    expect(historyToItems(messages)[0]).toMatchObject({ parentToolCallId: 'A', isError: true })
  })

  it('keeps the parent and the error from live events', () => {
    resetQueue()
    useChatStore.setState({ threads: {}, activeKey: null })
    const ingest = useChatStore.getState().ingest
    ingest('c1', {
      type: 'tool.started',
      threadId: 'T',
      toolId: 'b',
      toolName: 'Bash',
      input: {},
      parentToolCallId: 'A',
    })
    ingest('c1', { type: 'tool.completed', threadId: 'T', toolId: 'b', output: 'Exit code 1', isError: true })
    flushQueue()
    expect(useChatStore.getState().threads[threadKey('c1', 'T')].items[0]).toMatchObject({
      parentToolCallId: 'A',
      isError: true,
      state: 'done',
    })
  })
})
