import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import {
  publishChatWorkspace,
  resetChatWorkspaceRuntimeForTests,
} from '../../src/renderer/services/chatWorkspaceRuntime'
import { shouldSuppressTurnNotification } from '../../src/renderer/services/notifications'

describe('displayed chat visibility', () => {
  beforeEach(() => {
    resetChatWorkspaceRuntimeForTests()
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        provider: { stopSession: vi.fn(() => Promise.resolve()) },
        routing: { unbind: vi.fn() },
      },
    }
  })

  it('does not accrue unread for either visible panel', () => {
    const store = useAgentStore.getState()
    store.addSession({ id: 'left', type: 'codex', status: 'idle' })
    store.addSession({ id: 'right', type: 'claude-code', status: 'idle' })
    store.addSession({ id: 'background', type: 'opencode', status: 'idle' })
    publishChatWorkspace({
      primarySessionId: 'left',
      secondarySessionId: 'right',
      focusedSlot: 'primary',
      splitRatio: 0.5,
    })

    store.appendMessage('right', { id: 'r1', role: 'assistant', content: 'done', timestamp: 1 })
    store.appendMessage('background', { id: 'b1', role: 'assistant', content: 'done', timestamp: 2 })

    const sessions = useAgentStore.getState().sessions
    expect(sessions.find((session) => session.id === 'right')?.unreadCount).toBe(0)
    expect(sessions.find((session) => session.id === 'background')?.unreadCount).toBe(1)
  })

  it('suppresses a completion for either displayed chat only while the app is visible', () => {
    const displayed = ['left', 'right']

    expect(shouldSuppressTurnNotification('right', displayed, true)).toBe(true)
    expect(shouldSuppressTurnNotification('background', displayed, true)).toBe(false)
    expect(shouldSuppressTurnNotification('right', displayed, false)).toBe(false)
  })
})
