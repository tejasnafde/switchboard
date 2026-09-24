import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeModel, changeReasoningEffort, changeRuntimeMode } from '../../src/renderer/components/chat/chat-session-settings'
import { useAgentStore, getStoreDefaultRuntimeMode } from '../../src/renderer/stores/agent-store'
import { defaultModelSettingKey, SETTING_DEFAULT_RUNTIME_MODE } from '@shared/session-defaults'

const ok = () => vi.fn(async (..._args: unknown[]) => {})
let api: Record<string, Record<string, ReturnType<typeof ok>>>

beforeEach(() => {
  api = {
    provider: { setRuntimeMode: ok(), setModel: ok() },
    app: { setConversationRuntimeMode: ok(), setConversationModel: ok(), setConversationReasoningEffort: ok() },
    settings: { set: ok() },
  }
  ;(globalThis as unknown as { window: unknown }).window = { api }
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  useAgentStore.getState().addSession({ id: 's1', type: 'codex', status: 'idle' })
})

const session = () => useAgentStore.getState().sessions[0]

describe('chat session settings', () => {
  it('changeRuntimeMode updates the store, the live session, the conversation and the default', () => {
    changeRuntimeMode('s1', 'plan')
    expect(session().runtimeMode).toBe('plan')
    expect(api.provider.setRuntimeMode).toHaveBeenCalledWith('s1', 'plan')
    expect(api.app.setConversationRuntimeMode).toHaveBeenCalledWith('s1', 'plan')
    expect(api.settings.set).toHaveBeenCalledWith(SETTING_DEFAULT_RUNTIME_MODE, 'plan')
    expect(getStoreDefaultRuntimeMode()).toBe('plan')
  })

  it('changeModel files the machine default under the given agent', () => {
    changeModel('s1', 'codex', 'gpt-x')
    expect(session().model).toBe('gpt-x')
    expect(api.provider.setModel).toHaveBeenCalledWith('s1', 'gpt-x')
    expect(api.app.setConversationModel).toHaveBeenCalledWith('s1', 'gpt-x')
    expect(api.settings.set).toHaveBeenCalledWith(defaultModelSettingKey('codex'), 'gpt-x')
  })

  it('changeReasoningEffort updates the store and the conversation', () => {
    changeReasoningEffort('s1', 'high')
    expect(session().reasoningEffort).toBe('high')
    expect(api.app.setConversationReasoningEffort).toHaveBeenCalledWith('s1', 'high')
  })
})
