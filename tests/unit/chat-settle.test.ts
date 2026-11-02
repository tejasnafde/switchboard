import { describe, expect, it } from 'vitest'
import { isSettled, settledNoticeText, shouldAutoSettle } from '../../src/shared/chat-settle'
import { neighbourAfterRemoval } from '../../src/renderer/components/sidebar/recent-row-focus'

describe('isSettled', () => {
  it('is a flag the backend clears on a new turn, not a time compare', () => {
    expect(isSettled(null)).toBe(false)
    expect(isSettled(undefined)).toBe(false)
    expect(isSettled(200)).toBe(true)
  })
})

describe('shouldAutoSettle', () => {
  const idle = { state: 'merged' as const, busy: false, needsUser: false, settledAt: null }

  it('settles an idle chat whose linked PR changed to merged', () => {
    expect(shouldAutoSettle(idle)).toBe(true)
  })

  it('leaves a chat that runs a turn or waits on the user', () => {
    expect(shouldAutoSettle({ ...idle, busy: true })).toBe(false)
    expect(shouldAutoSettle({ ...idle, needsUser: true })).toBe(false)
  })

  it('does nothing for an open or closed PR', () => {
    expect(shouldAutoSettle({ ...idle, state: 'open' })).toBe(false)
    expect(shouldAutoSettle({ ...idle, state: 'closed' })).toBe(false)
  })

  it('does not settle a chat that is settled already', () => {
    expect(shouldAutoSettle({ ...idle, settledAt: 150 })).toBe(false)
  })
})

describe('settledNoticeText', () => {
  it('names the merged PR when one settled the chat', () => {
    expect(settledNoticeText('Fix login')).toBe('Settled Fix login')
    expect(settledNoticeText('Fix login', 452)).toBe('Settled Fix login: PR #452 merged')
  })
})

describe('neighbourAfterRemoval', () => {
  it('moves to the next row, the previous one when it was the last, or nowhere', () => {
    expect(neighbourAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(neighbourAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b')
    expect(neighbourAfterRemoval(['a'], 'a')).toBeNull()
    expect(neighbourAfterRemoval(['a'], 'x')).toBeNull()
  })
})
