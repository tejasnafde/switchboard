import { describe, expect, it } from 'vitest'
import { classifyCloseFocus, type ClosestEl } from '../../src/renderer/closeFocus'
import { resolveWorkspaceActionSession } from '../../src/renderer/services/workspaceRouting'
import type { ChatWorkspaceState } from '../../src/renderer/services/chatWorkspace'

const state: ChatWorkspaceState = {
  primarySessionId: 'left',
  secondarySessionId: 'right',
  focusedSlot: 'secondary',
  splitRatio: 0.5,
}

describe('workspace action routing', () => {
  it('prefers explicit message ownership over ambient focus', () => {
    expect(resolveWorkspaceActionSession(state, {
      explicitSessionId: 'message-owner',
      terminalSessionId: 'terminal-owner',
      ideSessionId: 'ide-owner',
      chatSlot: 'secondary',
    })).toBe('message-owner')
  })

  it('routes terminal and IDE origins to their authoritative binding', () => {
    expect(resolveWorkspaceActionSession(state, { terminalSessionId: 'terminal-owner' })).toBe('terminal-owner')
    expect(resolveWorkspaceActionSession(state, { ideSessionId: 'ide-owner' })).toBe('ide-owner')
  })

  it('routes a chat origin to its containing slot', () => {
    expect(resolveWorkspaceActionSession(state, { chatSlot: 'primary' })).toBe('left')
    expect(resolveWorkspaceActionSession(state, { chatSlot: 'secondary' })).toBe('right')
  })

  it('uses the stored focused slot after DOM focus becomes neutral', () => {
    expect(resolveWorkspaceActionSession(state, {})).toBe('right')
  })

  it('falls back to primary when the focused slot is unavailable', () => {
    expect(resolveWorkspaceActionSession({ ...state, secondarySessionId: null }, {})).toBe('left')
  })
})

describe('nested dual-chat close focus', () => {
  it('classifies the outer slot even when a nested chat root is the nearer generic panel', () => {
    const slot: ClosestEl = {
      closest: () => null,
      getAttribute: (name) => name === 'data-chat-slot' ? 'secondary' : null,
    }
    const nestedPanel: ClosestEl = {
      closest: (selector) => selector === '[data-chat-slot]' ? slot : null,
      getAttribute: (name) => name === 'data-chat-panel' ? 'true' : null,
    }
    const active: ClosestEl = {
      closest: (selector) => {
        if (selector === '[data-chat-panel]') return nestedPanel
        if (selector === '[data-chat-slot]') return slot
        return null
      },
      getAttribute: () => null,
    }

    expect(classifyCloseFocus(active)).toBe('chat-right')
  })
})
