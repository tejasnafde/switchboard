/**
 * Reviews refresh cadence (on focus and every 5 minutes while visible, never
 * faster) and the per-PR cache keyed by updated time.
 */
import { describe, expect, it } from 'vitest'
import { nextRefreshDelay, PR_FOCUS_MIN_GAP_MS, PR_REFRESH_INTERVAL_MS, pullRequestChanged, shouldRefreshPullRequests } from '../../src/shared/pull-request-refresh'
import { rollupChecks, type PrSummary } from '../../src/shared/pull-requests'
import { VersionedCache } from '../../src/main/pull-requests/cache'

const T = 1_000_000_000

describe('shouldRefreshPullRequests', () => {
  const state = (lastFetchAt: number | null, over: Partial<{ inFlight: boolean; visible: boolean }> = {}) => ({ lastFetchAt, inFlight: false, visible: true, ...over })

  it('reads on first open', () => {
    expect(shouldRefreshPullRequests(state(null), 'open', T)).toBe(true)
  })

  it('never reads while hidden or while a read is in flight', () => {
    expect(shouldRefreshPullRequests(state(null, { visible: false }), 'open', T)).toBe(false)
    expect(shouldRefreshPullRequests(state(null, { inFlight: true }), 'manual', T)).toBe(false)
    expect(shouldRefreshPullRequests(state(T - PR_REFRESH_INTERVAL_MS, { visible: false }), 'interval', T)).toBe(false)
  })

  it('polls every 5 minutes, not sooner', () => {
    expect(shouldRefreshPullRequests(state(T - PR_REFRESH_INTERVAL_MS + 1), 'interval', T)).toBe(false)
    expect(shouldRefreshPullRequests(state(T - PR_REFRESH_INTERVAL_MS), 'interval', T)).toBe(true)
    // Reopening the view inside the window reuses what it has.
    expect(shouldRefreshPullRequests(state(T - 60_000), 'open', T)).toBe(false)
  })

  it('reads on focus unless the last read was under a minute ago', () => {
    expect(shouldRefreshPullRequests(state(T - PR_FOCUS_MIN_GAP_MS + 1), 'focus', T)).toBe(false)
    expect(shouldRefreshPullRequests(state(T - PR_FOCUS_MIN_GAP_MS), 'focus', T)).toBe(true)
  })

  it('always reads on a manual refresh', () => {
    expect(shouldRefreshPullRequests(state(T - 1), 'manual', T)).toBe(true)
  })
})

describe('nextRefreshDelay', () => {
  it('counts from when the last read started', () => {
    expect(nextRefreshDelay(null, T)).toBe(0)
    expect(nextRefreshDelay(T - 60_000, T)).toBe(PR_REFRESH_INTERVAL_MS - 60_000)
    expect(nextRefreshDelay(T - 2 * PR_REFRESH_INTERVAL_MS, T)).toBe(0)
  })
})

describe('pullRequestChanged', () => {
  const base = {
    updatedAt: 1000,
    checks: rollupChecks([{ state: 'pending' }, { state: 'success' }]),
    unresolvedConversations: 2,
  } as PrSummary

  it('is false for the same PR, true when it was updated', () => {
    expect(pullRequestChanged(base, { ...base })).toBe(false)
    expect(pullRequestChanged(base, { ...base, updatedAt: 2000 })).toBe(true)
  })

  it('sees a check finishing that did not bump the updated time', () => {
    expect(pullRequestChanged(base, { ...base, checks: rollupChecks([{ state: 'failure' }, { state: 'success' }]) })).toBe(true)
    expect(pullRequestChanged(base, { ...base, checks: rollupChecks([{ state: 'pending' }, { state: 'success' }, { state: 'pending' }]) })).toBe(true)
  })

  it('sees a conversation resolved without a new comment', () => {
    expect(pullRequestChanged(base, { ...base, unresolvedConversations: 1 })).toBe(true)
  })
})

describe('VersionedCache', () => {
  it('hits only while the updated time is unchanged', () => {
    const cache = new VersionedCache<string>()
    cache.set('pr#1', '2026-09-27T10:00:00Z', 'a')
    expect(cache.get('pr#1', '2026-09-27T10:00:00Z')).toBe('a')
    expect(cache.get('pr#1', '2026-09-27T10:05:00Z')).toBeUndefined()
    expect(cache.get('pr#2', '2026-09-27T10:00:00Z')).toBeUndefined()
  })

  it('expires an entry that carries a max age, even when the version holds', () => {
    let now = T
    const cache = new VersionedCache<string>(10, () => now)
    cache.set('pr#1', 'v1', 'running', { maxAgeMs: 4 * 60_000 })
    now += 4 * 60_000 - 1
    expect(cache.get('pr#1', 'v1')).toBe('running')
    now += 1
    expect(cache.get('pr#1', 'v1')).toBeUndefined()
  })

  it('drops the least recently used entry past capacity', () => {
    const cache = new VersionedCache<number>(2)
    cache.set('a', 'v', 1)
    cache.set('b', 'v', 2)
    cache.get('a', 'v')
    cache.set('c', 'v', 3)
    expect(cache.get('b', 'v')).toBeUndefined()
    expect(cache.get('a', 'v')).toBe(1)
    expect(cache.size).toBe(2)
  })
})
