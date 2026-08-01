import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createContentCoalescer, type PendingContent } from '../../src/renderer/services/contentCoalescer'

describe('createContentCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('folds increments into one commit per message after the window', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', { text: 'a', append: true })
    c.push('t1', 'm1', { text: 'b', append: true })
    c.push('t1', 'm1', { text: 'c', append: true })
    expect(commits).toEqual([])
    vi.advanceTimersByTime(33)
    // Dropping intermediate commits must not drop characters. Last-write-wins
    // was only lossless while adapters re-sent the whole body every token.
    expect(commits).toEqual([{ threadId: 't1', messageId: 'm1', text: 'abc', append: true }])
  })

  it('lets a snapshot discard increments buffered before it', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', { text: 'partial', append: true })
    c.push('t1', 'm1', { text: 'whole' })
    vi.advanceTimersByTime(33)
    expect(commits).toEqual([{ threadId: 't1', messageId: 'm1', text: 'whole', append: undefined }])
  })

  it('preserves first-seen order across interleaved messages', () => {
    const commits: string[] = []
    const c = createContentCoalescer((p) => commits.push(p.messageId), 33)
    c.push('t1', 'assistant', { text: 'a' })
    c.push('t1', 'reasoning', { text: 'r' })
    c.push('t1', 'assistant', { text: 'ab' })
    vi.advanceTimersByTime(33)
    expect(commits).toEqual(['assistant', 'reasoning'])
  })

  it('flushThread commits that thread immediately and leaves others pending', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', { text: 'one' })
    c.push('t2', 'm2', { text: 'two' })
    c.flushThread('t1')
    expect(commits).toEqual([{ threadId: 't1', messageId: 'm1', text: 'one', append: undefined }])
    vi.advanceTimersByTime(33)
    expect(commits).toHaveLength(2)
    expect(commits[1]).toEqual({ threadId: 't2', messageId: 'm2', text: 'two', append: undefined })
  })

  it('does not double-commit after flushThread drains the timer', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', { text: 'one' })
    c.flushThread('t1')
    vi.advanceTimersByTime(100)
    expect(commits).toHaveLength(1)
  })

  it('dispose flushes everything pending', () => {
    const commits: PendingContent[] = []
    const c = createContentCoalescer((p) => commits.push(p), 33)
    c.push('t1', 'm1', { text: 'one' })
    c.push('t2', 'm2', { text: 'two' })
    c.dispose()
    expect(commits).toHaveLength(2)
  })
})
