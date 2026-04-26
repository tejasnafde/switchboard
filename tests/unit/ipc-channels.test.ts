import { describe, it, expect } from 'vitest'
import { AppChannels, AgentChannels, TerminalChannels } from '@shared/ipc-channels'

describe('IPC channel constants', () => {
  it('should have all conversation CRUD channels', () => {
    expect(AppChannels.CREATE_CONVERSATION).toBe('app:create-conversation')
    expect(AppChannels.LOAD_SESSION).toBe('app:load-session')
    expect(AppChannels.SAVE_MESSAGE).toBe('app:save-message')
    expect(AppChannels.RENAME_CONVERSATION).toBe('app:rename-conversation')
    expect(AppChannels.GET_CONVERSATIONS).toBe('app:get-conversations')
    expect(AppChannels.GET_PROJECTS).toBe('app:get-projects')
    expect(AppChannels.SET_VIBRANCY).toBe('app:set-vibrancy')
  })

  it('should not have duplicate channel values', () => {
    const allChannels = [
      ...Object.values(TerminalChannels),
      ...Object.values(AppChannels),
      ...Object.values(AgentChannels),
    ]
    const unique = new Set(allChannels)
    expect(unique.size).toBe(allChannels.length)
  })
})
