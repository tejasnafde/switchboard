import { useEffect, useRef, useCallback } from 'react'
import { useAgentStore } from '../stores/agent-store'
import type { AgentType, AgentStatus, ChatMessage } from '@shared/types'

interface UseAgentOptions {
  type: AgentType
  cwd?: string
}

export function useAgent({ type, cwd }: UseAgentOptions) {
  const sessionIdRef = useRef<string | null>(null)
  const initializedRef = useRef(false)
  const { addSession, updateStatus, appendMessage, removeSession } = useAgentStore()

  const send = useCallback((message: string) => {
    const id = sessionIdRef.current
    if (!id) return

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
    }
    appendMessage(id, userMessage)

    // invoke is async — agent spawns a process for each message
    window.api.agent.send({ id, message }).catch((err: Error) => {
      appendMessage(id, {
        id: `error_${Date.now()}`,
        role: 'system',
        content: `Failed to send: ${err.message}`,
        timestamp: Date.now(),
      })
    })
  }, [appendMessage])

  const start = useCallback(async () => {
    if (initializedRef.current) return
    initializedRef.current = true

    const id = `agent_${Date.now()}`
    sessionIdRef.current = id

    addSession({ id, type, status: 'idle' })

    await window.api.agent.start({
      id,
      type,
      cwd: cwd ?? '.',
    })
  }, [type, cwd, addSession])

  useEffect(() => {
    const removeMessage = window.api.agent.onMessage((agentId, message) => {
      if (agentId === sessionIdRef.current) {
        appendMessage(agentId, message as ChatMessage)
      }
    })

    const removeStatus = window.api.agent.onStatus((agentId, status) => {
      if (agentId === sessionIdRef.current) {
        updateStatus(agentId, status as AgentStatus)
      }
    })

    const removeError = window.api.agent.onError((agentId, error) => {
      if (agentId === sessionIdRef.current) {
        appendMessage(agentId, {
          id: `error_${Date.now()}`,
          role: 'system',
          content: `Error: ${error}`,
          timestamp: Date.now(),
        })
      }
    })

    return () => {
      removeMessage()
      removeStatus()
      removeError()
      if (sessionIdRef.current) {
        window.api.agent.kill(sessionIdRef.current)
        removeSession(sessionIdRef.current)
      }
      initializedRef.current = false
    }
  }, [appendMessage, updateStatus, removeSession])

  return { send, start, sessionId: sessionIdRef.current }
}
