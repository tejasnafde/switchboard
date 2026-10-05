import { afterEach, describe, expect, it, vi } from 'vitest'
const { end, perfSpan } = vi.hoisted(() => ({ end: vi.fn(), perfSpan: vi.fn() }))
vi.mock('../../src/main/perf', () => ({ perfSpan }))
import { LONG_RUNNING_CHANNELS, timeBackendHandler } from '../../src/main/backend/perf-handler'

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('backend handler timings', () => {
  it('preserves synchronous results and logs only slow calls', () => {
    perfSpan.mockReturnValue({ end })
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const handler = timeBackendHandler('app:read', (duration: number) => { now += duration; return 42 })
    expect(handler(200)).toBe(42)
    expect(end).not.toHaveBeenCalled()
    expect(handler(201)).toBe(42)
    expect(end).toHaveBeenCalledOnce()
    expect(perfSpan).toHaveBeenCalledWith('ipc', { channel: 'app:read' })
  })
  it('times asynchronous rejection without changing the error', async () => {
    perfSpan.mockReturnValue({ end })
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const failure = new Error('failure')
    const handler = timeBackendHandler('app:read', async () => { now = 201; throw failure })
    await expect(handler()).rejects.toBe(failure)
    expect(end).toHaveBeenCalledOnce()
  })
  it('skips handlers that wait for a turn or human answer', () => {
    const handler = () => 1
    for (const channel of LONG_RUNNING_CHANNELS) expect(timeBackendHandler(channel, handler)).toBe(handler)
    expect(perfSpan).not.toHaveBeenCalled()
  })
})
