import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armLimitResume, getLimitResume, setLimitResumeStreak } from '../../src/main/db/database'
import { LimitResumer, usageProbe, type LimitResumeHost } from '../../src/main/provider/limit-resume'
import type { ProviderUsage } from '../../src/shared/provider-usage'
import { limitResumeMarker, limitStateDetail, limitStateText, type LimitState } from '../../src/shared/limit-resume'
import { systemRowView } from '../../src/shared/system-markers'

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0)
const MIN = 60_000
const RESET = T0 + 2 * MIN

const usage = (reached: boolean, resetsAtMs: number | null = null): ProviderUsage => ({
  instanceId: 'i1',
  agentType: 'claude-code',
  status: 'ok',
  plan: null,
  account: null,
  windows: reached
    ? [
        {
          id: 's',
          label: '5-hour session',
          kind: 'session',
          usedPercent: 100,
          resetsAtMs,
          windowMinutes: 300,
          severity: 'critical',
        },
      ]
    : [],
  overage: [],
  fetchedAtMs: Date.now(),
})

class Host implements LimitResumeHost {
  flag = true
  setting = true
  live: string | null = 'c1'
  turnRunning = false
  card = false
  instance = 'i1'
  reading = usage(false)
  sendOk = true
  sent: string[] = []
  changes: Array<{ id: string; state: LimitState; resumed: boolean; gaveUp?: boolean }> = []
  enabled = () => this.flag
  settingOn = () => this.setting
  liveThread = () => this.live
  busy = () => this.turnRunning
  needsYou = () => this.card
  instanceOf = () => this.instance
  archived = () => false
  usage = async () => this.reading
  sendResume = async (threadId: string) => {
    this.sent.push(threadId)
    return this.sendOk
  }
  changed = (id: string, state: LimitState, resumed: boolean, gaveUp?: boolean) => {
    this.changes.push({ id, state, resumed, ...(gaveUp ? { gaveUp } : {}) })
  }
}

const limited = (resetAt: number | null = RESET) => ({ limitClass: 'usage_limit' as const, resetAt })

let host: Host
let resumer: LimitResumer

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  createMigratedDb()
  host = new Host()
  resumer = new LimitResumer(host)
})

afterEach(() => {
  resumer.dispose()
  vi.useRealTimers()
})

describe('LimitResumer', () => {
  it('resumes a chat limited with a reset in 2 minutes by itself, a minute after the reset', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    expect(getLimitResume('c1')).toMatchObject({ state: 'armed', resetAt: RESET, providerInstanceId: 'i1' })
    expect(resumer.view('c1')).toEqual({ kind: 'armed', resetAt: RESET })

    await vi.advanceTimersByTimeAsync(2 * MIN + 59_000)
    expect(host.sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.sent).toEqual(['c1'])
    expect(getLimitResume('c1')?.state).toBe('fired')
    expect(host.changes.at(-1)).toEqual({ id: 'c1', state: { kind: 'none' }, resumed: true })
  })

  it('does not resume after Stop, also after a restart', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    resumer.disarm('c1', 'stop')
    expect(resumer.view('c1')).toEqual({ kind: 'disarmed' })
    resumer.dispose()
    const restarted = new LimitResumer(host)
    restarted.start()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.sent).toEqual([])
    expect(getLimitResume('c1')).toMatchObject({ state: 'disarmed', disarmReason: 'stop' })
    restarted.dispose()
  })

  it('rebuilds an armed timer at startup', async () => {
    armLimitResume({
      conversationId: 'c1',
      providerInstanceId: 'i1',
      limitedTurnId: 't',
      resetAt: RESET,
      requestId: 'r',
    })
    resumer.start()
    expect(resumer.view('c1')).toEqual({ kind: 'armed', resetAt: RESET })
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual(['c1'])
  })

  it('gives up after 3 quick failures', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn0')
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(getLimitResume('c1')!.resetAt + MIN - Date.now())
      expect(host.sent).toHaveLength(i)
      await vi.advanceTimersByTimeAsync(30_000)
      resumer.onTurnEnded('c1', limited(Date.now() + 2 * MIN), `turn${i}`)
    }
    expect(getLimitResume('c1')).toMatchObject({ state: 'gave_up', streak: 3 })
    expect(resumer.view('c1')).toEqual({ kind: 'gave_up' })
    // The push fires on the one change that gave up.
    expect(host.changes.filter((c) => c.gaveUp)).toEqual([
      { id: 'c1', state: { kind: 'gave_up' }, resumed: false, gaveUp: true },
    ])
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.sent).toHaveLength(3)
  })

  it('a resumed turn that ends normally resets the streak', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn0')
    await vi.advanceTimersByTimeAsync(3 * MIN)
    resumer.onTurnEnded('c1', undefined, 'turn1')
    expect(getLimitResume('c1')).toMatchObject({ state: 'fired', streak: 0 })
  })

  it('Resume now with the window still closed keeps the row armed', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.reading = usage(true, RESET)
    expect(await resumer.resumeNow('c1')).toEqual({ ok: false, message: 'The usage window is still closed.' })
    expect(getLimitResume('c1')).toMatchObject({ state: 'armed', resetAt: RESET, streak: 0 })
    host.reading = usage(false)
    expect(await resumer.resumeNow('c1')).toEqual({ ok: true })
    expect(host.sent).toEqual(['c1'])
  })

  it('re-arms to the new reset when the window is still closed at the reset', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.reading = usage(true, RESET + 30 * MIN)
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual([])
    expect(getLimitResume('c1')).toMatchObject({ state: 'armed', resetAt: RESET + 30 * MIN, streak: 1 })
    host.reading = usage(false)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(host.sent).toEqual(['c1'])
  })

  it('setting off: nothing arms and the chat shows no Limited row', async () => {
    host.setting = false
    resumer.onTurnEnded('c1', limited(), 'turn1')
    expect(getLimitResume('c1')).toBeNull()
    expect(resumer.view('c1')).toEqual({ kind: 'none' })
  })

  it('flag off: nothing arms', () => {
    host.flag = false
    resumer.onTurnEnded('c1', limited(), 'turn1')
    expect(getLimitResume('c1')).toBeNull()
  })

  it('a limit without a reset time asks for a manual resume', () => {
    resumer.onTurnEnded('c1', limited(null), 'turn1')
    expect(getLimitResume('c1')).toBeNull()
    expect(resumer.view('c1')).toEqual({ kind: 'no_reset' })
  })

  it('a full context window is not a limit', () => {
    resumer.onTurnEnded('c1', { limitClass: 'context_full', resetAt: null }, 'turn1')
    expect(resumer.view('c1')).toEqual({ kind: 'none' })
  })

  it('a turn that ends normally before the reset disarms the row', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    resumer.onTurnEnded('c1', undefined, 'turn2')
    expect(getLimitResume('c1')).toMatchObject({ state: 'disarmed', disarmReason: 'ran' })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.sent).toEqual([])
  })

  it('arms once when one limited turn ends twice', () => {
    resumer.onTurnEnded('c1', limited(), undefined)
    const first = getLimitResume('c1')!.requestId
    resumer.onTurnEnded('c1', limited(), undefined)
    expect(getLimitResume('c1')!.requestId).toBe(first)
  })

  it('a Stop between a limit and its late second end keeps the row disarmed', async () => {
    resumer.onTurnEnded('c1', limited(), undefined)
    resumer.disarm('c1', 'stop')
    resumer.onTurnEnded('c1', limited(), undefined)
    expect(getLimitResume('c1')).toMatchObject({ state: 'disarmed', disarmReason: 'stop' })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(host.sent).toEqual([])
  })

  it('a new limit starts its streak at 0', () => {
    armLimitResume({
      conversationId: 'c1',
      providerInstanceId: 'i1',
      limitedTurnId: 't',
      resetAt: RESET,
      requestId: 'r',
    })
    setLimitResumeStreak('c1', 2, false)
    resumer.onTurnEnded('c1', limited(RESET + MIN), 'turn9')
    expect(getLimitResume('c1')).toMatchObject({ state: 'armed', streak: 0 })
  })

  it('a fire that finds a turn running tries again later', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.turnRunning = true
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual([])
    host.turnRunning = false
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(host.sent).toEqual(['c1'])
  })

  it('waits while a card is open, and for the session when the chat is not running', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.card = true
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual([])
    host.card = false
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(host.sent).toEqual(['c1'])

    resumer.onTurnEnded('c1', limited(Date.now() + MIN), 'turn2')
    host.live = null
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual(['c1'])
    host.live = 'c1'
    resumer.onSessionStarted('c1')
    await vi.advanceTimersByTimeAsync(0)
    expect(host.sent).toEqual(['c1', 'c1'])
  })

  it('does not fire on another account than the one that hit the limit', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.instance = 'i2'
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(host.sent).toEqual([])
    expect(getLimitResume('c1')).toMatchObject({ state: 'disarmed', disarmReason: 'moved' })
  })

  it('arms again when the resume turn could not be sent', async () => {
    resumer.onTurnEnded('c1', limited(), 'turn1')
    host.sendOk = false
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(getLimitResume('c1')?.state).toBe('armed')
    host.sendOk = true
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(host.sent).toEqual(['c1', 'c1'])
    expect(getLimitResume('c1')?.state).toBe('fired')
  })
})

describe('usageProbe', () => {
  it('reads a full window as closed until its reset', () => {
    expect(usageProbe(usage(true, RESET), T0)).toEqual({ open: false, resetAt: RESET })
    expect(usageProbe(usage(true, RESET), RESET + 1)).toEqual({ open: true })
    expect(usageProbe(usage(false), T0)).toEqual({ open: true })
    expect(usageProbe({ ...usage(true, RESET), status: 'error' }, T0)).toEqual({ open: true })
  })
})

describe('the Limited row and the resume row', () => {
  it('reads each state, and a stored resume row is a notice on every client', () => {
    const at = (ms: number) => new Date(ms).toISOString().slice(11, 16)
    expect(limitStateText({ kind: 'armed', resetAt: RESET }, at)).toBe('Usage limit. Resumes 12:02.')
    expect(limitStateText({ kind: 'gave_up' }, at)).toBe('Usage limit. Gave up after 3 tries.')
    expect(limitStateText({ kind: 'none' }, at)).toBeNull()
    expect(limitStateDetail({ kind: 'armed', resetAt: RESET })).toBe(
      'This chat carries on by itself then. A message you send now runs at once.',
    )
    for (const kind of ['disarmed', 'gave_up'] as const) {
      expect(limitStateDetail({ kind })).toBe('Send a message after the reset to continue.')
    }
    expect(limitStateDetail({ kind: 'no_reset' })).toBe('Send a message to try again. It fails while the limit lasts.')
    expect(limitStateDetail({ kind: 'none' })).toBeNull()
    expect(systemRowView(limitResumeMarker())).toEqual({
      kind: 'notice',
      title: 'Usage limit reset. Resumed the chat.',
      body: '',
    })
  })
})
