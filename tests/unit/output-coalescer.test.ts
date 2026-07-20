import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OutputCoalescer } from '../../src/main/terminal/output-coalescer'

describe('OutputCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches chunks within the window into one emit, per id', () => {
    const emitted: Array<[string, string]> = []
    const c = new OutputCoalescer((id, data) => emitted.push([id, data]), 8)
    c.push('t1', 'a')
    c.push('t1', 'b')
    c.push('t2', 'x')
    expect(emitted).toEqual([])
    vi.advanceTimersByTime(8)
    expect(emitted).toEqual([['t1', 'ab'], ['t2', 'x']])
  })

  it('flush(id) emits pending output immediately (EXIT ordering)', () => {
    const emitted: string[] = []
    const c = new OutputCoalescer((_id, data) => emitted.push(data), 8)
    c.push('t1', 'tail')
    c.flush('t1')
    expect(emitted).toEqual(['tail'])
    // Timer must not double-emit later.
    vi.advanceTimersByTime(20)
    expect(emitted).toEqual(['tail'])
  })

  it('flush with nothing pending is a no-op', () => {
    const emitted: string[] = []
    const c = new OutputCoalescer((_id, data) => emitted.push(data), 8)
    c.flush('nope')
    expect(emitted).toEqual([])
  })

  it('emits immediately once the buffer cap is hit', () => {
    const emitted: string[] = []
    const c = new OutputCoalescer((_id, data) => emitted.push(data), 8, 10)
    c.push('t1', '12345')
    c.push('t1', '67890')
    expect(emitted).toEqual(['1234567890'])
  })

  it('preserves chunk order across timer and cap flushes', () => {
    const emitted: string[] = []
    const c = new OutputCoalescer((_id, data) => emitted.push(data), 8, 10)
    c.push('t1', '123456789012')
    c.push('t1', 'after')
    vi.advanceTimersByTime(8)
    expect(emitted.join('')).toBe('123456789012after')
  })
})
