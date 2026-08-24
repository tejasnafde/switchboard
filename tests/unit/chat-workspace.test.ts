import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHAT_WORKSPACE,
  nextChatPresentation,
  nextDualChatShortcutAction,
  reconcileChatWorkspace,
  shouldEvictReplacedSession,
  shouldShowChatFocusIndicator,
  type ChatWorkspaceState,
} from '../../src/renderer/services/chatWorkspace'

const dual = (overrides: Partial<ChatWorkspaceState> = {}): ChatWorkspaceState => ({
  primarySessionId: 'a',
  secondarySessionId: 'b',
  focusedSlot: 'primary',
  splitRatio: 0.5,
  ...overrides,
})

describe('chat workspace reconciliation', () => {
  it('shows a pane focus indicator only when two chats are visibly split', () => {
    expect(shouldShowChatFocusIndicator(false, 'split')).toBe(false)
    expect(shouldShowChatFocusIndicator(true, 'tabs')).toBe(false)
    expect(shouldShowChatFocusIndicator(true, 'split')).toBe(true)
  })

  it('opens the first session as primary and focuses it', () => {
    expect(reconcileChatWorkspace(DEFAULT_CHAT_WORKSPACE, { type: 'select', sessionId: 'a' })).toEqual({
      primarySessionId: 'a',
      secondarySessionId: null,
      focusedSlot: 'primary',
      splitRatio: 0.5,
    })
  })

  it('opens a second session beside the primary without replacing it', () => {
    const state = reconcileChatWorkspace(
      { ...DEFAULT_CHAT_WORKSPACE, primarySessionId: 'a' },
      { type: 'open-beside', sessionId: 'b' },
    )
    expect(state).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'b',
      focusedSlot: 'secondary',
    })
  })

  it('focuses an already displayed session instead of duplicating it', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'select', sessionId: 'b' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'b',
      focusedSlot: 'secondary',
    })
    expect(reconcileChatWorkspace(dual(), { type: 'open-beside', sessionId: 'a' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'b',
      focusedSlot: 'primary',
    })
  })

  it('replaces the focused slot when selecting a third session', () => {
    expect(reconcileChatWorkspace(dual({ focusedSlot: 'secondary' }), { type: 'select', sessionId: 'c' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'c',
      focusedSlot: 'secondary',
    })
    expect(reconcileChatWorkspace(dual({ focusedSlot: 'primary' }), { type: 'select', sessionId: 'c' })).toMatchObject({
      primarySessionId: 'c',
      secondarySessionId: 'b',
      focusedSlot: 'primary',
    })
  })

  it('closes secondary without changing primary', () => {
    expect(reconcileChatWorkspace(dual({ focusedSlot: 'secondary' }), { type: 'close', slot: 'secondary' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
  })

  it('promotes secondary when primary closes', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'close', slot: 'primary' })).toMatchObject({
      primarySessionId: 'b',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
  })

  it('reconciles primary and secondary removal immediately', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'remove', sessionId: 'b' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
    expect(reconcileChatWorkspace(dual(), { type: 'remove', sessionId: 'a' })).toMatchObject({
      primarySessionId: 'b',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
  })

  it('preserves either slot across provider id rotation', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'rotate', fromSessionId: 'a', toSessionId: 'a2' })).toMatchObject({
      primarySessionId: 'a2',
      secondarySessionId: 'b',
    })
    expect(reconcileChatWorkspace(dual(), { type: 'rotate', fromSessionId: 'b', toSessionId: 'b2' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'b2',
    })
  })

  it('deduplicates aliases that resolve to the same canonical thread', () => {
    const canonical = (id: string) => ({ synthetic: 'thread-1', provider: 'thread-1' })[id] ?? id
    const state = reconcileChatWorkspace(
      { ...DEFAULT_CHAT_WORKSPACE, primarySessionId: 'synthetic' },
      { type: 'open-beside', sessionId: 'provider' },
      canonical,
    )
    expect(state).toMatchObject({
      primarySessionId: 'synthetic',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
  })

  it('focuses a canonical alias without replacing the loaded slot id', () => {
    const canonical = (id: string) => id === 'live-id' || id === 'stored-id' ? 'root-id' : id
    const state = dual({ primarySessionId: 'live-id', secondarySessionId: 'other', focusedSlot: 'secondary' })

    expect(reconcileChatWorkspace(state, { type: 'select', sessionId: 'stored-id' }, canonical)).toEqual({
      ...state,
      focusedSlot: 'primary',
    })
  })

  it('drops unavailable restored ids and promotes an available secondary', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'restore', availableSessionIds: ['b'] })).toMatchObject({
      primarySessionId: 'b',
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
    expect(reconcileChatWorkspace(dual(), { type: 'restore', availableSessionIds: [] })).toMatchObject({
      primarySessionId: null,
      secondarySessionId: null,
      focusedSlot: 'primary',
    })
  })

  it('keeps the source visible when forwarding to an undisplayed target', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'forward-target', sourceSessionId: 'a', targetSessionId: 'c' })).toMatchObject({
      primarySessionId: 'a',
      secondarySessionId: 'c',
      focusedSlot: 'secondary',
    })
    expect(reconcileChatWorkspace(dual(), { type: 'forward-target', sourceSessionId: 'b', targetSessionId: 'c' })).toMatchObject({
      primarySessionId: 'c',
      secondarySessionId: 'b',
      focusedSlot: 'primary',
    })
  })

  it('never forwards back to the source session', () => {
    expect(reconcileChatWorkspace(dual({ focusedSlot: 'secondary' }), {
      type: 'forward-target',
      sourceSessionId: 'b',
      targetSessionId: 'b',
    })).toEqual(dual({ focusedSlot: 'secondary' }))
  })

  it('clamps the split ratio without changing slot identity', () => {
    expect(reconcileChatWorkspace(dual(), { type: 'set-split-ratio', ratio: 0.02 })).toEqual(dual({ splitRatio: 0.2 }))
    expect(reconcileChatWorkspace(dual(), { type: 'set-split-ratio', ratio: 0.99 })).toEqual(dual({ splitRatio: 0.8 }))
  })

  it('collapses narrow and data-science chat docks with hysteresis', () => {
    expect(nextChatPresentation('split', 700, false, false)).toBe('tabs')
    expect(nextChatPresentation('tabs', 780, false, false)).toBe('tabs')
    expect(nextChatPresentation('tabs', 900, false, false)).toBe('split')
    expect(nextChatPresentation('split', 1200, true, false)).toBe('tabs')
  })

  it('freezes responsive presentation while the split handle is dragging', () => {
    expect(nextChatPresentation('split', 300, false, true)).toBe('split')
    expect(nextChatPresentation('tabs', 1200, false, true)).toBe('tabs')
  })

  it('never evicts a session that remains displayed after slot selection', () => {
    expect(shouldEvictReplacedSession('a', ['a', 'b'])).toBe(false)
    expect(shouldEvictReplacedSession('a', ['c', 'b'])).toBe(true)
  })

  it('gives native and renderer shortcuts the same open-or-close decision', () => {
    expect(nextDualChatShortcutAction(DEFAULT_CHAT_WORKSPACE)).toBe('open-picker')
    expect(nextDualChatShortcutAction(dual())).toBe('close-secondary')
  })
})
