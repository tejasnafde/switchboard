import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '@shared/provider-events'

const notifyTurnCompleted = vi.fn(async (_opts: unknown) => {})
vi.mock('../../src/renderer/services/notifications', () => ({
  notifyTurnCompleted: (opts: unknown) => notifyTurnCompleted(opts),
}))

import { reduceProviderEvent, upsertAssistantContent } from '../../src/renderer/components/chat/provider-event-reducer'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useKanbanStore } from '../../src/renderer/stores/kanban-store'
import { useSpendBlockStore } from '../../src/renderer/stores/spend-block-store'
import { onSessionActivity, onSessionRename, onUserTurnAccepted } from '../../src/renderer/services/session-events'
import type { ContentCoalescer } from '../../src/renderer/services/content-coalescer'

const T = 'thread-1'
const streaming = { streamingEnabled: true, coalescer: null }

function reduce(event: Record<string, unknown>, ctx: Parameters<typeof reduceProviderEvent>[1] = streaming): void {
  reduceProviderEvent({ threadId: T, ...event } as unknown as RuntimeEvent, ctx)
}
function session() {
  return useAgentStore.getState().sessions.find((s) => s.id === T)!
}
function messages() {
  return session().messages
}

const settingsGet = vi.fn(async (_key: string): Promise<string | null> => null)
const settingsSet = vi.fn(async (_key: string, _value: string) => {})
const setConversationModel = vi.fn(async (_id: string, _model: string) => {})

beforeEach(() => {
  notifyTurnCompleted.mockClear()
  settingsGet.mockReset().mockResolvedValue(null)
  settingsSet.mockClear()
  setConversationModel.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { settings: { get: settingsGet, set: settingsSet }, app: { setConversationModel } },
  }
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  useAgentStore.getState().addSession({ id: T, type: 'codex', status: 'running', title: 'My chat', projectPath: '/p/proj' })
})

describe('reduceProviderEvent (desktop)', () => {
  it('user.message appends the accepted user bubble, a handoff marker, and emits activity/rename/accepted', () => {
    const activity = vi.fn(); const rename = vi.fn(); const accepted = vi.fn()
    const off = [onSessionActivity(activity), onSessionRename(rename), onUserTurnAccepted(accepted)]
    reduce({ type: 'user.message', text: 'hi', at: 1000, origin: 'o1', conversationTitle: 'Title', handoffMarker: { id: 'h1', text: 'handoff' } })
    off.forEach((f) => f())
    expect(messages().map((m) => [m.id, m.role, m.content])).toEqual([
      ['h1', 'system', 'handoff'],
      [expect.any(String), 'user', 'hi'],
    ])
    expect(messages()[0].timestamp).toBe(999)
    expect(session().title).toBe('Title')
    expect(activity).toHaveBeenCalledWith(T, 1000)
    expect(rename).toHaveBeenCalledWith(T, 'Title')
    expect(accepted).toHaveBeenCalledWith(T, 'o1')
  })

  it('user.message updates an existing pending bubble in place and clears its delivery state', () => {
    reduce({ type: 'user.message', text: 'hi', at: 1000, origin: 'o1' })
    const id = messages()[0].id
    useAgentStore.getState().updateMessage(T, id, { deliveryState: 'pending' } as never)
    reduce({ type: 'user.message', text: 'hi edited', at: 1000, origin: 'o1' })
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ id, content: 'hi edited' })
    expect(messages()[0].deliveryState).toBeUndefined()
  })

  it('content with streaming on goes to the coalescer', () => {
    const push = vi.fn()
    reduce({ type: 'content', messageId: 'm1', text: 'a', append: true }, { streamingEnabled: true, coalescer: { push } as unknown as ContentCoalescer })
    expect(push).toHaveBeenCalledWith(T, 'm1', { text: 'a', append: true })
    expect(messages()).toEqual([])
  })

  it('content with streaming off buffers until turn.completed flushes it', () => {
    const off = { streamingEnabled: false, coalescer: null }
    reduce({ type: 'content', messageId: 'm1', text: 'Hel', append: true }, off)
    reduce({ type: 'content', messageId: 'm1', text: 'lo', append: true }, off)
    expect(messages()).toEqual([])
    reduce({ type: 'turn.completed' }, off)
    expect(messages()).toMatchObject([{ id: 'm1', role: 'assistant', content: 'Hello' }])
  })

  it('upsertAssistantContent appends then extends', () => {
    upsertAssistantContent(T, 'm1', { text: 'a' })
    upsertAssistantContent(T, 'm1', { text: 'b', append: true })
    expect(messages()).toMatchObject([{ id: 'm1', content: 'ab' }])
  })

  it('peer.message renders the sent marker with the own session label', () => {
    reduce({ type: 'peer.message', direction: 'sent', initiator: 'user', messageId: 'pm_1', peerThreadId: 't2', peerLabel: 'Other', text: 'x', at: 5 })
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ id: 'peer_pm_1', role: 'system' })
    expect(messages()[0].content).toContain('My chat → Other')
  })

  it('tool.started appends a tool bubble, and a repeat updates it in place', () => {
    reduce({ type: 'tool.started', toolId: 't1', toolName: 'Read', input: { a: 1 } })
    expect(messages()).toMatchObject([{ id: `tool_${T}:t1`, role: 'assistant', toolCalls: [{ id: 't1', name: 'Read', input: '{\n  "a": 1\n}' }] }])
    reduce({ type: 'tool.started', toolId: 't1', toolName: 'Write', input: 'raw' })
    expect(messages()).toHaveLength(1)
    expect(messages()[0].toolCalls).toEqual([{ id: 't1', name: 'Write', input: 'raw' }])
  })

  it('tool.completed stores output on the matching call, and ignores unknown ids', () => {
    reduce({ type: 'tool.started', toolId: 't1', toolName: 'Read', input: 'x' })
    reduce({ type: 'tool.completed', toolId: 't1', output: 'out' })
    reduce({ type: 'tool.completed', toolId: 'nope', output: 'x' })
    expect(messages()[0].toolCalls?.[0].output).toBe('out')
    expect(messages()).toHaveLength(1)
  })

  it('tool.denied appends a denial pill', () => {
    reduce({ type: 'tool.denied', toolName: 'Write', reason: 'plan', mode: 'plan' })
    expect(messages()[0]).toMatchObject({ role: 'system', content: '', denial: { toolName: 'Write', reason: 'plan', mode: 'plan' } })
    expect(messages()[0].id).toMatch(/^denied_/)
  })

  it('request.opened / request.closed drive the approval card', () => {
    reduce({ type: 'request.opened', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' })
    expect(messages()[0]).toMatchObject({ id: 'approval_r1', approval: { toolName: 'Bash', detail: 'ls', status: 'pending' } })
    reduce({ type: 'request.closed', requestId: 'r1', decision: 'approve' })
    expect(messages()[0].approval?.status).toBe('accepted')
    reduce({ type: 'request.opened', requestId: 'r2', requestType: 'command', toolName: 'Bash', detail: 'rm' })
    reduce({ type: 'request.closed', requestId: 'r2', decision: 'deny' })
    expect(messages()[1].approval?.status).toBe('rejected')
  })

  it('turn.completed stamps duration on the last assistant message, clears retry, and notifies', () => {
    upsertAssistantContent(T, 'a1', { text: 'one' })
    upsertAssistantContent(T, 'a2', { text: 'two' })
    reduce({ type: 'turn.retrying', turnId: 'x', message: 'Reconnecting... 1/5' })
    expect(messages().some((m) => m.id === 'provider_retry')).toBe(true)
    reduce({ type: 'turn.completed', durationMs: 1234 })
    expect(messages().find((m) => m.id === 'a2')?.turnDurationMs).toBe(1234)
    expect(messages().find((m) => m.id === 'a1')?.turnDurationMs).toBeUndefined()
    expect(messages().some((m) => m.id === 'provider_retry')).toBe(false)
    expect(notifyTurnCompleted).toHaveBeenCalledWith(expect.objectContaining({
      sessionTitle: 'My chat', projectName: 'proj', agentLabel: 'Codex', threadId: T,
    }))
  })

  it('turn.retrying upserts one retry card', () => {
    reduce({ type: 'turn.retrying', turnId: 'x', message: 'Reconnecting... 1/5' })
    reduce({ type: 'turn.retrying', turnId: 'x', message: 'Reconnecting... 2/5' })
    expect(messages().filter((m) => m.id === 'provider_retry')).toHaveLength(1)
  })

  it('context_window sets token usage, cost and resolved model', () => {
    reduce({ type: 'context_window', usedTokens: 10, maxTokens: 100, costUsd: 0.5, model: 'm-x' })
    expect(session()).toMatchObject({ costUsd: 0.5, resolvedModel: 'm-x' })
    expect(JSON.stringify(session())).toContain('"usedTokens":10')
  })

  it('session.provider sets the instance id', () => {
    reduce({ type: 'session.provider', provider: 'codex', instanceId: 'inst-2', instanceName: 'Work' })
    expect(session().instanceId).toBe('inst-2')
    reduce({ type: 'session.provider', provider: 'codex', instanceId: null, instanceName: null })
    expect(session().instanceId).toBeUndefined()
  })

  it('spend.blocked records a block only when the model is known', () => {
    const record = vi.fn()
    useSpendBlockStore.setState({ record })
    reduce({ type: 'spend.blocked', instanceId: 'i', model: null, reason: 'r', scope: 'x', resetsAtMs: null })
    expect(record).not.toHaveBeenCalled()
    reduce({ type: 'spend.blocked', instanceId: 'i', model: 'm', reason: 'r', scope: 'x', resetsAtMs: 9 })
    expect(record).toHaveBeenCalledWith({ instanceId: 'i', model: 'm', reason: 'r', scope: 'x', resetsAtMs: 9 })
  })

  it('model.unavailable clears a matching pick and machine default, and posts a notice', async () => {
    useAgentStore.getState().setModel(T, 'old-model')
    settingsGet.mockResolvedValue('old-model')
    reduce({ type: 'model.unavailable', model: 'old-model' })
    expect(session().model).toBe('')
    expect(setConversationModel).toHaveBeenCalledWith(T, '')
    await vi.waitFor(() => expect(settingsSet).toHaveBeenCalledWith(expect.stringContaining('codex'), ''))
    expect(messages().at(-1)?.content).toBe('old-model is not available on this account any more. This chat now uses the default model.')
  })

  it('model.unavailable leaves a newer pick alone', () => {
    useAgentStore.getState().setModel(T, 'newer')
    reduce({ type: 'model.unavailable', model: 'old-model' })
    expect(session().model).toBe('newer')
    expect(setConversationModel).not.toHaveBeenCalled()
  })

  it('model.variants sets the variant set', () => {
    reduce({ type: 'model.variants', modelId: 'm', availableVariants: ['low', 'high'], currentVariant: 'high' })
    expect(session()).toMatchObject({ availableVariants: ['low', 'high'], currentVariant: 'high' })
  })

  it('plan.proposed appends a plan card', () => {
    reduce({ type: 'plan.proposed', planId: 'p1', planMarkdown: '# plan' })
    expect(messages()[0]).toMatchObject({ id: 'plan_p1', role: 'assistant', plan: { id: 'p1', markdown: '# plan' } })
  })

  it('todo.updated replaces its card in place', () => {
    reduce({ type: 'todo.updated', todoId: 'l1', items: [{ text: 'a', status: 'pending' }] })
    reduce({ type: 'todo.updated', todoId: 'l1', items: [{ text: 'a', status: 'completed' }] })
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ id: 'todo_l1', todos: { id: 'l1', items: [{ text: 'a', status: 'completed' }] } })
  })

  it('question.asked / question.answered drive the question card and the linked kanban card', () => {
    const update = vi.fn(async () => {})
    let status = 'in_progress'
    useKanbanStore.setState({ update, findByConversationId: (id: string) => (id === T ? { id: 'card', status } : undefined) } as never)
    reduce({ type: 'question.asked', requestId: 'q1', questions: [] })
    expect(messages()[0]).toMatchObject({ id: 'question_q1', question: { requestId: 'q1', questions: [], status: 'pending' } })
    expect(update).toHaveBeenCalledWith('card', { status: 'needs_input' })
    status = 'needs_input'
    reduce({ type: 'question.answered', requestId: 'q1', answers: [['yes']] })
    expect(messages()[0].question).toMatchObject({ status: 'answered', answers: [['yes']] })
    expect(update).toHaveBeenLastCalledWith('card', { status: 'in_progress' })
  })

  it('question.asked leaves a card that is not in progress alone', () => {
    const update = vi.fn(async () => {})
    useKanbanStore.setState({ update, findByConversationId: () => ({ id: 'card', status: 'backlog' }) } as never)
    reduce({ type: 'question.asked', requestId: 'q1', questions: [] })
    expect(update).not.toHaveBeenCalled()
  })

  it('file.edited appends a pending diff card and coalesces re-edits', () => {
    const base = { turnId: '1', fileEditId: 'f1', repoRoot: '/r', relPath: 'a.ts', changeKind: 'modify', oldContent: 'a' }
    reduce({ type: 'file.edited', ...base, newContent: 'b' })
    reduce({ type: 'file.edited', ...base, newContent: 'c' })
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ id: 'filediff_f1', fileDiff: { relPath: 'a.ts', newContent: 'c', status: 'pending' } })
  })

  it('session.execution-root-changed applies the committed root', () => {
    reduce({ type: 'session.execution-root-changed', machineId: 'local', from: { path: '/p/proj', branch: 'main' }, to: { path: '/wt', branch: 'b', isWorktree: true }, revision: 1 })
    expect(session()).toMatchObject({ worktreePath: '/wt', worktreeBranch: 'b' })
  })

  it('worktree.drift suggests a new worktree but not the one already followed', () => {
    reduce({ type: 'worktree.drift', worktreePath: '/wt', branch: 'b' })
    expect(session().driftSuggestion).toEqual({ worktreePath: '/wt', branch: 'b', followSuggestions: 'auto', workedWorktrees: 0 })
    useAgentStore.getState().setDriftSuggestion(T, null)
    useAgentStore.getState().setWorktree(T, '/wt', 'b')
    reduce({ type: 'worktree.drift', worktreePath: '/wt', branch: 'b' })
    expect(session().driftSuggestion ?? null).toBeNull()
  })

  it('worktree.drift carries the chat setting and says nothing when muted', () => {
    reduce({ type: 'worktree.drift', worktreePath: '/wt2', branch: 'c', followSuggestions: 'on', workedWorktrees: 4 })
    expect(session().driftSuggestion).toEqual({ worktreePath: '/wt2', branch: 'c', followSuggestions: 'on', workedWorktrees: 4 })
    // Muted elsewhere while this window still shows the chip: it goes.
    reduce({ type: 'worktree.drift', worktreePath: '/wt3', branch: 'd', followSuggestions: 'muted', workedWorktrees: 1 })
    expect(session().driftSuggestion ?? null).toBeNull()
  })

  it('error appends a system error and clears the retry card', () => {
    reduce({ type: 'turn.retrying', turnId: 'x', message: 'Reconnecting... 1/5' })
    reduce({ type: 'error', message: 'boom' })
    expect(messages().map((m) => m.content)).toEqual(['Error: boom'])
  })

  it('status updates the session and clears the retry card unless running', () => {
    reduce({ type: 'turn.retrying', turnId: 'x', message: 'Reconnecting... 1/5' })
    reduce({ type: 'status', status: 'running' })
    expect(messages()).toHaveLength(1)
    reduce({ type: 'status', status: 'idle' })
    expect(session().status).toBe('idle')
    expect(messages()).toEqual([])
  })

  it('ignores event types it does not handle', () => {
    reduce({ type: 'session', sessionId: 's' })
    reduce({ type: 'thread.read', at: 1 })
    expect(messages()).toEqual([])
  })
})

describe('agent store queued messages', () => {
  const track = (event: Record<string, unknown>) =>
    useAgentStore.getState().trackQueuedTurnEvent({ threadId: T, ...event } as unknown as RuntimeEvent)

  it('marks a row queued even before its echo lands, and unmarks it when it runs', () => {
    track({ type: 'turn.queued', messageId: 'remote_q', text: 'later', queuedAt: 1 })
    expect(session().queuedTurns?.remote_q?.text).toBe('later')
    useAgentStore.getState().appendMessage(T, { id: 'remote_q', role: 'user', content: 'later', timestamp: 1 })
    track({ type: 'turn.dequeued', messageId: 'remote_q', reason: 'started' })
    expect(session().queuedTurns).toEqual({})
    expect(messages().map((m) => m.id)).toEqual(['remote_q'])
  })

  it('drops the row of a cancelled message on every client', () => {
    useAgentStore.getState().appendMessage(T, { id: 'remote_q', role: 'user', content: 'take back', timestamp: 1 })
    track({ type: 'turn.queued', messageId: 'remote_q', text: 'take back', queuedAt: 1 })
    track({ type: 'turn.dequeued', messageId: 'remote_q', reason: 'cancelled' })
    expect(messages()).toEqual([])
    expect(session().queuedTurns).toEqual({})
  })

  it('seeds from the backend list', () => {
    useAgentStore.getState().setQueuedTurns(T, [{ threadId: T, messageId: 'remote_x', text: 'x', queuedAt: 2 }])
    expect(Object.keys(session().queuedTurns ?? {})).toEqual(['remote_x'])
  })

  it('counts queued-turn events so a recovery can tell it raced one, and ignores the rest', () => {
    const before = session().queuedTurnRevision ?? 0
    track({ type: 'content', messageId: 'm', streamKind: 'assistant', text: 'x' })
    expect(session().queuedTurnRevision ?? 0).toBe(before)
    track({ type: 'turn.queued', messageId: 'remote_r', text: 'r', queuedAt: 1 })
    track({ type: 'turn.dequeued', messageId: 'remote_r', reason: 'promoted' })
    expect(session().queuedTurnRevision).toBe(before + 2)
  })
})
