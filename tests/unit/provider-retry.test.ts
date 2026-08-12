import { beforeEach, describe, expect, it } from 'vitest'
import { clearProviderRetry, upsertProviderRetry } from '../../src/renderer/components/chat/providerRetry'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

describe('provider retry status', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    useAgentStore.getState().addSession({ id: 'thread-1', type: 'codex', status: 'running' })
  })

  it('updates one temporary card per session and removes it on completion', () => {
    upsertProviderRetry('thread-1', 'Reconnecting... 1/5')
    upsertProviderRetry('thread-1', 'Reconnecting... 2/5')

    const messages = useAgentStore.getState().sessions[0].messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'provider_retry',
      role: 'system',
      content: 'Codex disconnected · retrying 2/5',
    })

    clearProviderRetry('thread-1')
    expect(useAgentStore.getState().sessions[0].messages).toEqual([])
  })
})
