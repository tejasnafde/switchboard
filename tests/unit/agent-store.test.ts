import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

describe('agent-store', () => {
  beforeEach(() => {
    // Reset store between tests
    useAgentStore.setState({
      sessions: [],
      activeSessionId: null,
    })
  })

  it('should add a session and set it as active', () => {
    useAgentStore.getState().addSession({
      id: 'test-1',
      type: 'claude-code',
      status: 'idle',
    })

    const state = useAgentStore.getState()
    expect(state.sessions).toHaveLength(1)
    expect(state.activeSessionId).toBe('test-1')
    expect(state.sessions[0].messages).toEqual([])
  })

  it('should append messages to a session', () => {
    const { addSession, appendMessage } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })
    appendMessage('s1', {
      id: 'msg1',
      role: 'user',
      content: 'hello',
      timestamp: 1000,
    })

    const session = useAgentStore.getState().sessions[0]
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content).toBe('hello')
  })

  it('should bulk-set messages for a session via setMessages', () => {
    const { addSession, setMessages } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })

    const messages = [
      { id: 'msg1', role: 'user' as const, content: 'hi', timestamp: 1000 },
      { id: 'msg2', role: 'assistant' as const, content: 'hello', timestamp: 2000 },
    ]
    setMessages('s1', messages)

    const session = useAgentStore.getState().sessions[0]
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0].content).toBe('hi')
    expect(session.messages[1].content).toBe('hello')
  })

  it('should track conversationId on a session', () => {
    const { addSession } = useAgentStore.getState()
    addSession({
      id: 's1',
      type: 'claude-code',
      status: 'idle',
      conversationId: 'conv-123',
      projectPath: '/projects/foo',
    })

    const session = useAgentStore.getState().sessions[0]
    expect(session.conversationId).toBe('conv-123')
    expect(session.projectPath).toBe('/projects/foo')
  })

  it('should update conversationId via setConversationId', () => {
    const { addSession, setConversationId } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })
    setConversationId('s1', 'conv-456')

    const session = useAgentStore.getState().sessions[0]
    expect(session.conversationId).toBe('conv-456')
  })

  it('should update a message in-place via updateMessage (streaming)', () => {
    const { addSession, appendMessage, updateMessage } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })
    appendMessage('s1', {
      id: 'stream-1',
      role: 'assistant',
      content: 'Hello',
      timestamp: 1000,
    })

    // Simulate streaming update
    updateMessage('s1', 'stream-1', { content: 'Hello, how are you?' })

    const session = useAgentStore.getState().sessions[0]
    expect(session.messages).toHaveLength(1) // Still 1 message, not 2
    expect(session.messages[0].content).toBe('Hello, how are you?')
    expect(session.messages[0].id).toBe('stream-1')
  })

  it('should clear messages for a session', () => {
    const { addSession, appendMessage, clearMessages } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })
    appendMessage('s1', { id: 'msg1', role: 'user', content: 'hi', timestamp: 1000 })
    clearMessages('s1')

    const session = useAgentStore.getState().sessions[0]
    expect(session.messages).toHaveLength(0)
  })

  it('appendMessage is idempotent — duplicate IDs are silently dropped', () => {
    // Regression: with two ChatPanel panes mounted, each registers its own
    // ipcRenderer event listener. Every provider event (tool.started, content,
    // etc.) fires once per pane, so appendMessage can be called twice with the
    // same message ID.  The store must ignore the second call.
    const { addSession, appendMessage } = useAgentStore.getState()
    addSession({ id: 's1', type: 'claude-code', status: 'idle' })

    const msg = { id: 'tool_toolu_01ABC', role: 'assistant' as const, content: '', timestamp: 1000 }
    appendMessage('s1', msg)
    appendMessage('s1', msg) // second call — same id, same content
    appendMessage('s1', { ...msg, content: 'different' }) // same id, different content

    const session = useAgentStore.getState().sessions[0]
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].id).toBe('tool_toolu_01ABC')
    // Original content is preserved — later duplicates don't overwrite
    expect(session.messages[0].content).toBe('')
  })
})
