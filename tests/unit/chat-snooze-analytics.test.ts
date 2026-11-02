/** The backend counts snoozes it accepted (kind = preset, target = surface) and the wakes a user sees. */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackAnalyticsEvent = vi.fn()
vi.mock('../../src/main/analytics', () => ({ trackAnalyticsEvent }))

const { ChatSnoozer } = await import('../../src/main/conversations/chat-snooze')

const T0 = new Date(2026, 10, 2, 9, 0).getTime()
const HOUR = 3600_000
let snoozer: InstanceType<typeof ChatSnoozer>

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  createMigratedDb().exec(
    "INSERT INTO projects (path, name) VALUES ('/r', 'r'); INSERT INTO conversations (id, project_path, title) VALUES ('c', '/r', 'Chat')",
  )
  trackAnalyticsEvent.mockClear()
  snoozer = new ChatSnoozer({ emit: vi.fn(), needsYou: () => false }, () => Date.now())
  snoozer.start()
})

afterEach(() => {
  snoozer.dispose()
  vi.useRealTimers()
})

describe('snooze analytics', () => {
  it('counts an accepted snooze with its preset and surface, and not an Undo or a refusal', async () => {
    await snoozer.snooze('c', { until: T0 + HOUR, preset: 'tonight', surface: 'context_menu' })
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('chat_snoozed', { kind: 'tonight', target: 'context_menu' })
    trackAnalyticsEvent.mockClear()
    await snoozer.snooze('c', { until: T0 - 5 * HOUR, preset: 'tonight', surface: 'row' })
    snoozer.wake('c', 'undo', {})
    await snoozer.snooze('c', { until: T0 + 2 * HOUR })
    expect(trackAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('counts a wake by its reason, Wake now included, and not the silent ones', async () => {
    await snoozer.snooze('c', { until: T0 + HOUR })
    vi.advanceTimersByTime(HOUR)
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('chat_woke', { kind: 'time' })
    await snoozer.snooze('c', { until: T0 + 3 * HOUR })
    snoozer.wake('c', 'wake_now')
    expect(trackAnalyticsEvent).toHaveBeenLastCalledWith('chat_woke', { kind: 'wake_now' })
    await snoozer.snooze('c', { until: T0 + 3 * HOUR })
    trackAnalyticsEvent.mockClear()
    snoozer.wake('c', 'settle')
    expect(trackAnalyticsEvent).not.toHaveBeenCalled()
  })
})
