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
