import { describe, expect, it } from 'vitest'
import { isSettled, settledNoticeText, shouldAutoSettle } from '../../src/shared/chat-settle'
import { neighbourAfterRemoval } from '../../src/renderer/components/sidebar/recent-row-focus'

describe('isSettled', () => {
  it('holds until the chat has newer activity', () => {
    expect(isSettled(null, 100)).toBe(false)
    expect(isSettled(undefined, 100)).toBe(false)
    expect(isSettled(200, 100)).toBe(true)
    expect(isSettled(200, 200)).toBe(true)
    expect(isSettled(200, 201)).toBe(false)
  })
})

describe('shouldAutoSettle', () => {
  const idle = { state: 'merged' as const, busy: false, needsUser: false, settledAt: null, lastActivity: 100 }

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

  it('does not settle a chat that is settled already, but does one with newer activity', () => {
    expect(shouldAutoSettle({ ...idle, settledAt: 150 })).toBe(false)
    expect(shouldAutoSettle({ ...idle, settledAt: 50 })).toBe(true)
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
