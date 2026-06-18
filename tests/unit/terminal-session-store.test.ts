/**
 * Terminal session support in agent-store.
 *
 * Terminal sessions (type='terminal') differ from SDK-backed sessions:
 *   - They carry a `terminalPaneId` pointing into terminal-registry.
 *   - They have no messages, cost, or streaming state.
 *   - After restart the PTY is gone; the store holds the session as idle.
 *
 * These tests verify that the store correctly stores and retrieves terminal
 * sessions, and that they don't interfere with SDK-backed sessions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  // Stub stopSession to avoid "window is not defined" in removeSession
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { provider: { stopSession: vi.fn(() => Promise.resolve()) } },
  }
})

describe('terminal sessions in agent-store', () => {
  it('adds a terminal session with terminalPaneId', () => {
    useAgentStore.getState().addSession({
      id: 'ts1',
      type: 'terminal',
      status: 'idle',
      projectPath: '/projects/foo',
      terminalPaneId: 'term_1234',
      title: 'claude',
    })
    const session = useAgentStore.getState().sessions[0]
    expect(session.type).toBe('terminal')
    expect(session.terminalPaneId).toBe('term_1234')
    expect(session.projectPath).toBe('/projects/foo')
    expect(session.title).toBe('claude')
  })

  it('getActiveSession returns the terminal session when active', () => {
    useAgentStore.getState().addSession({
      id: 'ts1',
      type: 'terminal',
      status: 'idle',
      terminalPaneId: 'term_abc',
    })
    useAgentStore.getState().setActiveSession('ts1')
    const active = useAgentStore.getState().getActiveSession()
    expect(active?.type).toBe('terminal')
    expect(active?.terminalPaneId).toBe('term_abc')
  })

  it('terminal session starts with empty messages', () => {
    useAgentStore.getState().addSession({
      id: 'ts1',
      type: 'terminal',
      status: 'idle',
      terminalPaneId: 'term_x',
    })
    expect(useAgentStore.getState().sessions[0].messages).toEqual([])
  })

  it('terminal and SDK sessions coexist without interference', () => {
    useAgentStore.getState().addSession({ id: 'sdk1', type: 'claude-code', status: 'idle' })
    useAgentStore.getState().addSession({
      id: 'term1',
      type: 'terminal',
      status: 'idle',
      terminalPaneId: 'pane_99',
    })

    const sessions = useAgentStore.getState().sessions
    expect(sessions).toHaveLength(2)

    const sdk = sessions.find((s) => s.id === 'sdk1')!
    const term = sessions.find((s) => s.id === 'term1')!

    expect(sdk.type).toBe('claude-code')
    expect(sdk.terminalPaneId).toBeUndefined()
    expect(term.type).toBe('terminal')
    expect(term.terminalPaneId).toBe('pane_99')
  })

  it('terminal session without terminalPaneId is valid (post-restart idle)', () => {
    // After restart the PTY is gone but the DB record remains. We add the
    // session as idle without a paneId — the center pane shows nothing.
    useAgentStore.getState().addSession({
      id: 'ts1',
      type: 'terminal',
      status: 'idle',
      title: 'claude',
    })
    const session = useAgentStore.getState().sessions[0]
    expect(session.terminalPaneId).toBeUndefined()
    expect(session.status).toBe('idle')
  })

  it('removeSession cleans up terminal session from the store', () => {
    useAgentStore.getState().addSession({
      id: 'ts1',
      type: 'terminal',
      status: 'idle',
      terminalPaneId: 'pane_1',
    })
    useAgentStore.getState().removeSession('ts1')
    expect(useAgentStore.getState().sessions).toHaveLength(0)
  })
})
