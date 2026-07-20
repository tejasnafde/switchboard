import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createContentCoalescer, type PendingContent } from '../../src/renderer/services/contentCoalescer'

describe('createContentCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('commits only the latest snapshot per message after the window', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', 'a')
    c.push('t1', 'm1', 'ab')
    c.push('t1', 'm1', 'abc')
    expect(commits).toEqual([])
    vi.advanceTimersByTime(33)
    expect(commits).toEqual([{ threadId: 't1', messageId: 'm1', text: 'abc' }])
  })

  it('preserves first-seen order across interleaved messages', () => {
    const commits: string[] = []
    const c = createContentCoalescer((p) => commits.push(p.messageId), 33)
    c.push('t1', 'assistant', 'a')
    c.push('t1', 'reasoning', 'r')
    c.push('t1', 'assistant', 'ab')
    vi.advanceTimersByTime(33)
    expect(commits).toEqual(['assistant', 'reasoning'])
  })

  it('flushThread commits that thread immediately and leaves others pending', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', 'one')
    c.push('t2', 'm2', 'two')
    c.flushThread('t1')
    expect(commits).toEqual([{ threadId: 't1', messageId: 'm1', text: 'one' }])
    vi.advanceTimersByTime(33)
    expect(commits).toHaveLength(2)
    expect(commits[1]).toEqual({ threadId: 't2', messageId: 'm2', text: 'two' })
  })

  it('does not double-commit after flushThread drains the timer', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', 'one')
    c.flushThread('t1')
    vi.advanceTimersByTime(100)
    expect(commits).toHaveLength(1)
  })

  it('dispose flushes everything pending', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', 'one')
    c.push('t2', 'm2', 'two')
    c.dispose()
    expect(commits).toHaveLength(2)
  })
})
