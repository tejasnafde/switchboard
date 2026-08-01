/**
 * Notification payload to Thread route, and the edge-swipe-back thresholds.
 */
import { describe, it, expect } from 'vitest'
import { threadRouteFromPush } from '../../apps/mobile/src/lib/pushRoute'
import {
  shouldClaimEdgeSwipe,
  edgeSwipeCommits,
  EDGE_WIDTH,
  COMMIT_DX,
  COMMIT_VX,
} from '../../apps/mobile/src/lib/gestures'

describe('threadRouteFromPush', () => {
  it('builds a route from a full payload', () => {
    expect(
      threadRouteFromPush({
        threadId: 't1',
        clientRef: 'conn-1',
        title: 'Fix the parser',
        projectPath: '/repo',
        kind: 'approval',
      }),
    ).toEqual({
      connectionId: 'conn-1',
      threadId: 't1',
      title: 'Fix the parser',
      projectPath: '/repo',
      isNew: false,
    })
  })

  it('refuses a payload with no clientRef, since the backend is unknown', () => {
    // Devices registered before clientRef existed land here. Guessing which of
    // several paired backends sent it would open the wrong conversation.
    expect(threadRouteFromPush({ threadId: 't1' })).toBeNull()
  })

  it('refuses a payload with no threadId', () => {
    expect(threadRouteFromPush({ clientRef: 'conn-1' })).toBeNull()
  })

  it('substitutes a title rather than refusing, since the screen reloads it', () => {
    expect(threadRouteFromPush({ threadId: 't', clientRef: 'c' })).toMatchObject({
      title: 'Conversation',
      projectPath: '',
    })
    expect(threadRouteFromPush({ threadId: 't', clientRef: 'c', title: '' })?.title).toBe('Conversation')
  })

  it('tolerates any shape without throwing', () => {
    expect(threadRouteFromPush(null)).toBeNull()
    expect(threadRouteFromPush(undefined)).toBeNull()
    expect(threadRouteFromPush('nope')).toBeNull()
    expect(threadRouteFromPush({})).toBeNull()
    expect(threadRouteFromPush({ threadId: 42, clientRef: 7 })).toBeNull()
  })
})

describe('shouldClaimEdgeSwipe', () => {
  it('claims a rightward drag that starts at the left edge', () => {
    expect(shouldClaimEdgeSwipe(5, 30, 2)).toBe(true)
  })

  it('ignores a drag that starts away from the edge', () => {
    expect(shouldClaimEdgeSwipe(EDGE_WIDTH + 1, 60, 0)).toBe(false)
  })

  it('ignores a leftward drag', () => {
    expect(shouldClaimEdgeSwipe(5, -60, 0)).toBe(false)
  })

  it('leaves a vertical scroll alone, which is used far more than back', () => {
    expect(shouldClaimEdgeSwipe(5, 14, 60)).toBe(false)
    expect(shouldClaimEdgeSwipe(5, 14, -60)).toBe(false)
  })

  it('ignores a drag too small to be intentional', () => {
    expect(shouldClaimEdgeSwipe(5, 4, 0)).toBe(false)
  })
})

describe('edgeSwipeCommits', () => {
  it('commits on enough travel', () => {
    expect(edgeSwipeCommits(COMMIT_DX, 0)).toBe(true)
    expect(edgeSwipeCommits(COMMIT_DX - 1, 0)).toBe(false)
  })

  it('commits on a flick, even a short one', () => {
    expect(edgeSwipeCommits(20, COMMIT_VX)).toBe(true)
  })

  it('does not commit on a slow short drag', () => {
    expect(edgeSwipeCommits(20, 0.1)).toBe(false)
  })
})
