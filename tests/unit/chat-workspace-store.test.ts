import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'

describe('chat workspace store integration', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    useLayoutStore.setState({
      primarySessionId: null,
      secondarySessionId: null,
      focusedChatSlot: 'primary',
      chatSplitRatio: 0.5,
    })
  })

  it('keeps the legacy active id as a primary-only mirror', () => {
    useLayoutStore.getState().selectChatSession('a')
    useLayoutStore.getState().openChatBeside('b')

    expect(useLayoutStore.getState()).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'b',
      focusedChatSlot: 'secondary',
    })
    expect(useAgentStore.getState().activeSessionId).toBe('a')
  })

  it('derives focused, displayed, and companion sessions independently', () => {
    useLayoutStore.getState().selectChatSession('a')
    useLayoutStore.getState().openChatBeside('b')

    const store = useLayoutStore.getState()
    expect(store.focusedChatSessionId()).toBe('b')
    expect(store.companionSessionId()).toBe('b')
    expect(store.displayedChatSessionIds()).toEqual(['a', 'b'])
    expect(store.sessionForChatSlot('primary')).toBe('a')
    expect(store.slotForChatSession('b')).toBe('secondary')
  })

  it('sidebar-style selection replaces the focused slot without changing the other', () => {
    useLayoutStore.getState().selectChatSession('a')
    useLayoutStore.getState().openChatBeside('b')
    useLayoutStore.getState().selectChatSession('c')

    expect(useLayoutStore.getState()).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'c',
      focusedChatSlot: 'secondary',
    })
    expect(useAgentStore.getState().activeSessionId).toBe('a')
  })

  it('routes legacy active-session writes through the focused slot', () => {
    useLayoutStore.getState().selectChatSession('a')
    useLayoutStore.getState().openChatBeside('b')

    useAgentStore.getState().setActiveSession('c')

    expect(useLayoutStore.getState()).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'c',
      focusedChatSlot: 'secondary',
    })
    expect(useAgentStore.getState().activeSessionId).toBe('a')
  })

  it('promotes the secondary and updates the primary mirror when primary closes', () => {
    useLayoutStore.getState().selectChatSession('a')
    useLayoutStore.getState().openChatBeside('b')
    useLayoutStore.getState().closeChatSlot('primary')

    expect(useLayoutStore.getState()).toMatchObject({
      primarySessionId: 'b',
      secondarySessionId: null,
      focusedChatSlot: 'primary',
    })
    expect(useAgentStore.getState().activeSessionId).toBe('b')
  })

  it('reconciles stale restored bindings against available sessions', () => {
    useLayoutStore.setState({ primarySessionId: 'gone', secondarySessionId: 'b', focusedChatSlot: 'primary' })
    useLayoutStore.getState().reconcileChatSessions(['b'])

    expect(useLayoutStore.getState()).toMatchObject({
      primarySessionId: 'b',
      secondarySessionId: null,
      focusedChatSlot: 'primary',
    })
    expect(useAgentStore.getState().activeSessionId).toBe('b')
  })
})
