import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { recoverPendingRequests } from '../../src/renderer/services/pending-request-recovery'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'

function setWindowApi(getPendingRequests: (threadId: string) => Promise<PendingBlockingEvent[]>) {
  ;(globalThis as unknown as { window: { api: { provider: { getPendingRequests: typeof getPendingRequests } } } }).window = {
    api: { provider: { getPendingRequests } },
  }
}

describe('recoverPendingRequests (desktop orchestration)', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [] })
  })

  it('records an unopened chat as waiting without giving it messages', async () => {
    const opened: PendingBlockingEvent = { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' }
    setWindowApi(vi.fn(() => Promise.resolve([opened])))
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })

    await recoverPendingRequests('t1', { cards: false })

    const session = useAgentStore.getState().sessions.find((s) => s.id === 't1')
    expect(session?.pendingRequests).toEqual([opened])
    expect(session?.messages).toEqual([])
  })

  it('advances the recorded cards from live events for that thread only', () => {
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })
    const store = () => useAgentStore.getState()
    store().trackPendingRequestEvent({ type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' })
    store().trackPendingRequestEvent({ type: 'request.opened', threadId: 'other', requestId: 'r2', requestType: 'command', toolName: 'Bash', detail: 'ls' })
    expect(store().sessions[0].pendingRequests?.map((e) => e.type)).toEqual(['request.opened'])

    const before = store().sessions
    store().trackPendingRequestEvent({ type: 'content', threadId: 't1', messageId: 'm', streamKind: 'assistant', text: 'x' } as never)
    expect(store().sessions).toBe(before)

    store().trackPendingRequestEvent({ type: 'request.closed', threadId: 't1', requestId: 'r1', decision: 'approve' })
    expect(store().sessions[0].pendingRequests).toEqual([])
  })

  it('discards a snapshot that a live event overtook while it was in flight, and asks again', async () => {
    const opened: PendingBlockingEvent = { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' }
    const answers: PendingBlockingEvent[][] = [[opened], []]
    const getPendingRequests = vi.fn(async () => {
      const answer = answers.shift() ?? []
      // The close lands while the first request is still on the wire. Nothing
      // is recorded yet, so it changes no card - only the revision.
      if (answer.length) useAgentStore.getState().trackPendingRequestEvent({ type: 'request.closed', threadId: 't1', requestId: 'r1', decision: 'approve' })
      return answer
    })
    setWindowApi(getPendingRequests)
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })

    await recoverPendingRequests('t1')

    expect(getPendingRequests).toHaveBeenCalledTimes(2)
    const session = useAgentStore.getState().sessions.find((s) => s.id === 't1')
    expect(session?.pendingRequests ?? []).toEqual([])
    expect(session?.messages).toEqual([])
  })

  it('appends a missing card to an already-loaded session', async () => {
    const getPendingRequests = vi.fn(() => Promise.resolve<PendingBlockingEvent[]>([
      { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' },
    ]))
    setWindowApi(getPendingRequests)
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })

    await recoverPendingRequests('t1')

    expect(getPendingRequests).toHaveBeenCalledWith('t1')
    const session = useAgentStore.getState().sessions.find((s) => s.id === 't1')
    expect(session?.messages).toEqual([
      expect.objectContaining({
        id: 'approval_r1',
        approval: { toolName: 'Bash', detail: 'ls', status: 'pending' },
      }),
    ])
  })

  it('does not duplicate a card already shown', async () => {
    const getPendingRequests = vi.fn(() => Promise.resolve<PendingBlockingEvent[]>([
      { type: 'request.opened', threadId: 't1', requestId: 'r1', requestType: 'command', toolName: 'Bash', detail: 'ls' },
    ]))
    setWindowApi(getPendingRequests)
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })
    useAgentStore.getState().appendMessage('t1', {
      id: 'approval_r1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      approval: { toolName: 'Bash', detail: 'ls', status: 'accepted' },
    })

    await recoverPendingRequests('t1')

    const session = useAgentStore.getState().sessions.find((s) => s.id === 't1')
    // The already-shown card (already decided, "accepted") is left alone -
    // recovery must not stomp a resolved card with the backend's stale copy.
    expect(session?.messages).toHaveLength(1)
    expect(session?.messages[0].approval?.status).toBe('accepted')
  })

  it('is a no-op when the session has not been loaded into the store yet', async () => {
    const getPendingRequests = vi.fn(() => Promise.resolve<PendingBlockingEvent[]>([
      { type: 'plan.proposed', threadId: 'unknown', planId: 'p1', planMarkdown: '# Plan' },
    ]))
    setWindowApi(getPendingRequests)

    await expect(recoverPendingRequests('unknown')).resolves.toBeUndefined()
    expect(useAgentStore.getState().sessions).toHaveLength(0)
  })

  it('is a no-op when the backend has nothing pending', async () => {
    const getPendingRequests = vi.fn(() => Promise.resolve<PendingBlockingEvent[]>([]))
    setWindowApi(getPendingRequests)
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })

    await recoverPendingRequests('t1')

    expect(useAgentStore.getState().sessions.find((s) => s.id === 't1')?.messages).toEqual([])
  })

  it('logs and does not throw when the backend call fails', async () => {
    const getPendingRequests = vi.fn(() => Promise.reject(new Error('backend unreachable')))
    setWindowApi(getPendingRequests)
    useAgentStore.getState().addSession({ id: 't1', type: 'claude-code', status: 'idle' })

    await expect(recoverPendingRequests('t1')).resolves.toBeUndefined()
  })
})
