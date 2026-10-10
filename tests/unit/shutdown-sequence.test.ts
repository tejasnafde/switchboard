import { afterEach, describe, expect, it, vi } from 'vitest'
import { runShutdownSequence, type ShutdownStep } from '../../src/main/shutdown-sequence'

const quietLog = () => ({ info: vi.fn(), warn: vi.fn() })

afterEach(() => {
  vi.useRealTimers()
})

describe('runShutdownSequence', () => {
  it('runs steps in order and waits for each before starting the next', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const steps: ShutdownStep[] = [
      {
        name: 'terminals',
        run: () =>
          new Promise<void>((resolve) => {
            events.push('terminals:start')
            releaseFirst = () => {
              events.push('terminals:end')
              resolve()
            }
          }),
      },
      {
        name: 'database',
        run: () => {
          events.push('database')
        },
      },
    ]
    const done = runShutdownSequence(steps, { log: quietLog() })
    await vi.waitFor(() => expect(events).toEqual(['terminals:start']))
    releaseFirst()
    const reports = await done
    expect(events).toEqual(['terminals:start', 'terminals:end', 'database'])
    expect(reports.map((r) => [r.name, r.outcome])).toEqual([
      ['terminals', 'ok'],
      ['database', 'ok'],
    ])
  })

  it('carries on past a step that throws or rejects, and logs it', async () => {
    const log = quietLog()
    const ran: string[] = []
    const reports = await runShutdownSequence(
      [
        {
          name: 'sync-throw',
          run: () => {
            throw new Error('boom')
          },
        },
        {
          name: 'async-reject',
          run: async () => {
            throw new Error('bang')
          },
        },
        {
          name: 'database',
          run: () => {
            ran.push('database')
          },
        },
      ],
      { log },
    )
    expect(ran).toEqual(['database'])
    expect(reports.map((r) => r.outcome)).toEqual(['failed', 'failed', 'ok'])
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('moves on from a hung step after its timeout, and a late rejection stays handled', async () => {
    vi.useFakeTimers()
    const log = quietLog()
    let rejectHung!: (err: Error) => void
    const ran: string[] = []
    const done = runShutdownSequence(
      [
        {
          name: 'providers',
          run: () =>
            new Promise<void>((_, reject) => {
              rejectHung = reject
            }),
          timeoutMs: 5_000,
        },
        {
          name: 'database',
          run: () => {
            ran.push('database')
          },
        },
      ],
      { log },
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(ran).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    const reports = await done
    expect(reports.map((r) => r.outcome)).toEqual(['timed-out', 'ok'])
    expect(ran).toEqual(['database'])

    rejectHung(new Error('late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(log.warn).toHaveBeenLastCalledWith('shutdown step providers failed after timing out', expect.any(Error))
  })

  it('uses the default timeout when a step names none', async () => {
    vi.useFakeTimers()
    const done = runShutdownSequence([{ name: 'hang', run: () => new Promise<void>(() => {}) }], {
      log: quietLog(),
      defaultTimeoutMs: 100,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect((await done)[0].outcome).toBe('timed-out')
  })
})
