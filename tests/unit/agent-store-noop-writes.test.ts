/**
 * A write that changes nothing must leave the agent store state untouched, so
 * subscribers to `sessions` do not re-render. Status events repeat on every
 * streamed token, and selecting the shown chat again is common.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  for (const id of ['a', 'b']) {
    useAgentStore.getState().addSession({
      id,
      agentType: 'claude-code',
      status: 'idle',
      projectPath: '/tmp/p',
      title: id,
      startedAt: 0,
    })
  }
})

describe('agent-store no-op writes', () => {
  it('updateStatus with the current status keeps the state', () => {
    useAgentStore.getState().updateStatus('a', 'running')
    const before = useAgentStore.getState()
    useAgentStore.getState().updateStatus('a', 'running')
    useAgentStore.getState().updateStatus('missing', 'running')
    expect(useAgentStore.getState()).toBe(before)
  })

  it('updateStatus with a new status replaces only that session', () => {
    const [, b] = useAgentStore.getState().sessions
    useAgentStore.getState().updateStatus('a', 'running')
    const after = useAgentStore.getState().sessions
    expect(after[0].status).toBe('running')
    expect(after[1]).toBe(b)
  })

  it('markSessionRead on a read session keeps the state', () => {
    const before = useAgentStore.getState()
    useAgentStore.getState().markSessionRead('a')
    expect(useAgentStore.getState()).toBe(before)
  })

  it('selecting the chat already shown keeps the agent state', () => {
    useLayoutStore.getState().selectChatSession('a')
    const before = useAgentStore.getState()
    useLayoutStore.getState().selectChatSession('a')
    useAgentStore.getState().setActiveSession('a')
    expect(useAgentStore.getState()).toBe(before)
  })

  it('selecting a chat with unread messages clears its count', () => {
    useAgentStore.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === 'b' ? { ...x, unreadCount: 3 } : x)) }))
    useAgentStore.getState().setActiveSession('b')
    const state = useAgentStore.getState()
    expect(state.activeSessionId).toBe('b')
    expect(state.sessions.find((x) => x.id === 'b')?.unreadCount).toBe(0)
  })
})
