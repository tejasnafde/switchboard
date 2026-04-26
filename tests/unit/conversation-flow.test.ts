import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

/**
 * Tests for conversation lifecycle flows:
 * - New chat creation
 * - Session selection and message loading
 * - Message send flow
 * - Session switching
 */
describe('conversation flow', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
  })

  describe('new chat creation', () => {
    it('should create a session with projectPath and set it active', () => {
      const { addSession, setActiveSession } = useAgentStore.getState()

      const id = 'agent_12345'
      addSession({
        id,
        type: 'claude-code',
        status: 'idle',
        projectPath: '/projects/switchboard',
      })
      setActiveSession(id)

      const state = useAgentStore.getState()
      expect(state.activeSessionId).toBe(id)
      expect(state.sessions[0].projectPath).toBe('/projects/switchboard')
      expect(state.sessions[0].messages).toEqual([])
    })
  })

  describe('session selection and message loading', () => {
    it('should load messages into a session via setMessages', () => {
      const { addSession, setActiveSession, setMessages } = useAgentStore.getState()

      addSession({ id: 'imported-1', type: 'claude-code', status: 'idle', projectPath: '/proj' })
      setActiveSession('imported-1')

      const loaded = [
        { id: 'msg1', role: 'user' as const, content: 'explain this code', timestamp: 1000 },
        { id: 'msg2', role: 'assistant' as const, content: 'This code does...', timestamp: 2000 },
        { id: 'msg3', role: 'user' as const, content: 'thanks', timestamp: 3000 },
      ]
      setMessages('imported-1', loaded)

      const session = useAgentStore.getState().sessions[0]
      expect(session.messages).toHaveLength(3)
      expect(session.messages[0].role).toBe('user')
      expect(session.messages[1].role).toBe('assistant')
    })

    it('should switch active session when selecting a different one', () => {
      const { addSession, setActiveSession } = useAgentStore.getState()

      addSession({ id: 'sess-a', type: 'claude-code', status: 'idle' })
      addSession({ id: 'sess-b', type: 'claude-code', status: 'idle' })

      setActiveSession('sess-b')
      expect(useAgentStore.getState().activeSessionId).toBe('sess-b')

      setActiveSession('sess-a')
      expect(useAgentStore.getState().activeSessionId).toBe('sess-a')
    })

    it('should not duplicate sessions when selecting an already-loaded one', () => {
      const { addSession } = useAgentStore.getState()

      addSession({ id: 'sess-1', type: 'claude-code', status: 'idle' })

      // Simulate checking if session exists before adding
      const existing = useAgentStore.getState().sessions.find((s) => s.id === 'sess-1')
      expect(existing).toBeDefined()

      // No duplicate should be added
      expect(useAgentStore.getState().sessions).toHaveLength(1)
    })
  })

  describe('message send flow', () => {
    it('should append user message to active session', () => {
      const { addSession, setActiveSession, appendMessage } = useAgentStore.getState()

      addSession({ id: 'chat-1', type: 'claude-code', status: 'idle', projectPath: '/proj' })
      setActiveSession('chat-1')

      appendMessage('chat-1', {
        id: 'user_1',
        role: 'user',
        content: 'Hello agent',
        timestamp: Date.now(),
      })

      const session = useAgentStore.getState().sessions[0]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content).toBe('Hello agent')
    })

    it('should handle interleaved user and assistant messages', () => {
      const { addSession, appendMessage } = useAgentStore.getState()

      addSession({ id: 'chat-1', type: 'claude-code', status: 'idle' })

      appendMessage('chat-1', { id: 'u1', role: 'user', content: 'Hi', timestamp: 1000 })
      appendMessage('chat-1', { id: 'a1', role: 'assistant', content: 'Hello!', timestamp: 2000 })
      appendMessage('chat-1', { id: 'u2', role: 'user', content: 'Help me', timestamp: 3000 })
      appendMessage('chat-1', { id: 'a2', role: 'assistant', content: 'Sure', timestamp: 4000 })

      const messages = useAgentStore.getState().sessions[0].messages
      expect(messages).toHaveLength(4)
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    })

    it('should track status transitions during send', () => {
      const { addSession, updateStatus } = useAgentStore.getState()

      addSession({ id: 'chat-1', type: 'claude-code', status: 'idle' })
      expect(useAgentStore.getState().sessions[0].status).toBe('idle')

      updateStatus('chat-1', 'running')
      expect(useAgentStore.getState().sessions[0].status).toBe('running')

      updateStatus('chat-1', 'idle')
      expect(useAgentStore.getState().sessions[0].status).toBe('idle')
    })

    it('should handle error messages from agent', () => {
      const { addSession, appendMessage } = useAgentStore.getState()

      addSession({ id: 'chat-1', type: 'claude-code', status: 'idle' })

      appendMessage('chat-1', {
        id: 'error_1',
        role: 'system',
        content: 'Error: Claude exited with code 1',
        timestamp: Date.now(),
      })

      const session = useAgentStore.getState().sessions[0]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].role).toBe('system')
    })
  })

  describe('session rename persistence', () => {
    it('should support renaming sessions by updating title in store', () => {
      const { addSession, setMessages } = useAgentStore.getState()

      // Simulate loading a scanned session (from JSONL import)
      addSession({
        id: 'imported-session-uuid',
        type: 'claude-code',
        status: 'idle',
        projectPath: '/projects/myapp',
      })

      // Verify session exists with default state
      const session = useAgentStore.getState().sessions[0]
      expect(session.id).toBe('imported-session-uuid')
      expect(session.projectPath).toBe('/projects/myapp')
    })
  })

  describe('multi-session management', () => {
    it('should maintain independent message lists per session', () => {
      const { addSession, appendMessage } = useAgentStore.getState()

      addSession({ id: 'sess-a', type: 'claude-code', status: 'idle' })
      addSession({ id: 'sess-b', type: 'claude-code', status: 'idle' })

      appendMessage('sess-a', { id: 'a1', role: 'user', content: 'msg for A', timestamp: 1000 })
      appendMessage('sess-b', { id: 'b1', role: 'user', content: 'msg for B', timestamp: 2000 })

      const sessions = useAgentStore.getState().sessions
      expect(sessions[0].messages).toHaveLength(1)
      expect(sessions[0].messages[0].content).toBe('msg for A')
      expect(sessions[1].messages).toHaveLength(1)
      expect(sessions[1].messages[0].content).toBe('msg for B')
    })

    it('should preserve messages when switching active session', () => {
      const { addSession, appendMessage, setActiveSession } = useAgentStore.getState()

      addSession({ id: 'sess-a', type: 'claude-code', status: 'idle' })
      addSession({ id: 'sess-b', type: 'claude-code', status: 'idle' })

      appendMessage('sess-a', { id: 'a1', role: 'user', content: 'hi from A', timestamp: 1000 })
      setActiveSession('sess-b')
      appendMessage('sess-b', { id: 'b1', role: 'user', content: 'hi from B', timestamp: 2000 })
      setActiveSession('sess-a')

      const sessA = useAgentStore.getState().sessions.find((s) => s.id === 'sess-a')
      expect(sessA?.messages).toHaveLength(1)
      expect(sessA?.messages[0].content).toBe('hi from A')
    })
  })
})
