import { describe, expect, it, vi } from 'vitest'
import { createPerfSpan, PERF_THRESHOLDS } from '../../src/shared/perf-timing'
import { parsePerfLogs, summarizePerf } from '../../src/shared/perf-summary'

describe('performance spans', () => {
  it('uses the monotonic clock, merges fields and ends once', () => {
    let now = 10
    const log = { info: vi.fn(), debug: vi.fn() }
    const span = createPerfSpan(log, () => now)('chat.open', { thread: 't' })
    now = 311
    expect(span.end({ messages: 4 })).toBe(301)
    span.end()
    expect(log.info).toHaveBeenCalledExactlyOnceWith('chat.open 301ms {"thread":"t","messages":4}')
  })
  it('uses debug at the threshold and info only above it', () => {
    let now = 0
    const log = { info: vi.fn(), debug: vi.fn() }
    const perfSpan = createPerfSpan(log, () => now)
    for (const name of ['chat.open', 'provider.switch', 'ipc'] as const) {
      const span = perfSpan(name)
      now += PERF_THRESHOLDS[name]
      span.end()
    }
    expect(log.debug).toHaveBeenCalledTimes(3)
    expect(log.info).not.toHaveBeenCalled()
  })
})

describe('performance summary', () => {
  it('parses scoped file and renderer lines, ignoring damaged and unrelated lines', () => {
    const warn = vi.fn()
    const entries = parsePerfLogs(
      '[INF] [perf] chat.open 812ms {"messages":3}\n[DBG] [perf] ipc 12.5ms {"channel":"x"}\n[SB:perf] chat.open 4ms {}\n[perf] bad 3ms {bad}\n[perf] truncated 3ms {\n[other] chat.open 5ms {}\n[perf] bad NaNms {}',
      warn,
    )
    expect(entries).toHaveLength(3)
    expect(warn).toHaveBeenCalledOnce()
    expect(entries[0]).toEqual({ name: 'chat.open', durationMs: 812, fields: { messages: 3 } })
  })
  it('calculates nearest-rank percentiles and the worst five per span', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: 'chat.open',
      durationMs: i + 1,
      fields: { thread: String(i) },
    }))
    expect(summarizePerf(entries)[0]).toMatchObject({ name: 'chat.open', count: 10, p50: 5, p90: 9, max: 10 })
    expect(summarizePerf(entries)[0].worst.map((e) => e.durationMs)).toEqual([10, 9, 8, 7, 6])
    expect(summarizePerf([])).toEqual([])
  })
})
