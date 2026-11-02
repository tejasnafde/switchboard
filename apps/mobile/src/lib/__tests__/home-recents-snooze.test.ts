import type { Project } from '@shared/types'
import { canSnooze, homeRecents, sessionsFromProjects, withSnoozeEvent, type HomeMachine } from '../home-recents'
import { snoozeRequestFor, snoozeSheetItems } from '../snooze-sheet'

const base = { source: 'claude-code' as const, messageCount: 1, filePath: '' }

const project: Project = {
  path: '/repo',
  name: 'repo',
  sessions: [
    { ...base, id: 'plain', title: 'Plain', startedAt: 500 },
    {
      ...base,
      id: 'tomorrow',
      title: 'Tomorrow',
      startedAt: 400,
      snoozedAt: 10,
      snoozedUntil: 2_000_000,
      snoozeRev: 1,
    },
    {
      ...base,
      id: 'pr',
      title: 'On a PR',
      startedAt: 300,
      snoozedAt: 10,
      snoozedUntil: null,
      snoozePr: 'github:acme/app#512',
    },
    { ...base, id: 'tonight', title: 'Tonight', startedAt: 200, snoozedAt: 10, snoozedUntil: 1_000_000 },
    { ...base, id: 'woke', title: 'Woke', startedAt: 100, wokeAt: 50, wokeReason: 'time' },
  ],
}

function machine(patch: Partial<HomeMachine> = {}, statuses: Record<string, string> = {}): HomeMachine {
  return {
    connectionId: 'mac',
    label: 'Studio Mac',
    connected: true,
    sessions: sessionsFromProjects([project]),
    live: { mark: 0, statuses },
    snooze: true,
    ...patch,
  }
}

describe('snoozed chats on Home > Recents', () => {
  it('moves snoozed chats to the shelf, the soonest wake first and PR-only last', () => {
    const page = homeRecents([machine()], {}, 10)
    expect(page.items.map((row) => row.id)).toEqual(['woke', 'plain'])
    expect(page.snoozed.map((row) => row.id)).toEqual(['tonight', 'tomorrow', 'pr'])
    expect(page.total).toBe(2)
  })

  it('keeps a snoozed chat in the shelf while it works', () => {
    const page = homeRecents([machine({}, { tomorrow: 'running' })], {}, 10)
    expect(page.items.map((row) => row.id)).not.toContain('tomorrow')
    expect(page.snoozed.find((row) => row.id === 'tomorrow')?.status).toBe('Working')
  })

  it('sorts a woken chat first in its status, and marks it', () => {
    const page = homeRecents([machine()], {}, 10)
    expect(page.items[0]).toMatchObject({ id: 'woke', woke: true })
    expect(page.items[1]).toMatchObject({ id: 'plain', woke: false })
  })

  it('ignores every snooze field from a backend without chat_snooze_v1', () => {
    const page = homeRecents([machine({ snooze: false })], {}, 10)
    expect(page.snoozed).toEqual([])
    expect(page.items.map((row) => row.id)).toEqual(['plain', 'tomorrow', 'pr', 'tonight', 'woke'])
    expect(page.items.some((row) => row.woke || row.snoozable)).toBe(false)
  })

  it('offers Snooze on every row but one that needs the user', () => {
    const page = homeRecents([machine({}, { plain: 'error' })], {}, 10)
    expect(page.items.map((row) => [row.id, canSnooze(row)])).toEqual([
      ['plain', false],
      ['woke', true],
    ])
  })

  it('applies a broadcast to the chat it names, and leaves other lists alone', () => {
    const sessions = sessionsFromProjects([project])
    const woken = withSnoozeEvent(sessions, {
      conversationId: 'tonight',
      snoozedUntil: null,
      snoozedAt: null,
      snoozePr: null,
      snoozeRev: 3,
      wokeAt: 1_000_000,
      wokeReason: 'pr',
      prSummary: 'PR #512: checks failed',
    })
    expect(woken.find((s) => s.id === 'tonight')).toMatchObject({
      snoozedAt: null,
      wokeAt: 1_000_000,
      wokePrSummary: 'PR #512: checks failed',
    })
    const page = homeRecents([machine({ sessions: woken })], {}, 10)
    expect(page.items.map((row) => [row.id, row.woke])).toEqual([
      ['tonight', true],
      ['woke', true],
      ['plain', false],
    ])
    expect(
      withSnoozeEvent(sessions, {
        ...woken[0],
        conversationId: 'elsewhere',
        snoozeRev: 0,
        wokeAt: null,
        wokeReason: null,
        snoozedAt: null,
        snoozedUntil: null,
        snoozePr: null,
      }),
    ).toBe(sessions)
  })
})

describe('the Snooze sheet', () => {
  // Monday 2 November 2026, 09:00 local.
  const monday = new Date(2026, 10, 2, 9, 0)

  it('lists the presets with their wake times, then the PR item', () => {
    const items = snoozeSheetItems(monday, { key: 'github:acme/app#512', number: 512 })
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ['Later today', '12:00'],
      ['Tonight', '20:00'],
      ['Tomorrow morning', 'Tue 09:00'],
      ['Next week', '9 Nov'],
      ['Until PR #512 changes', ''],
    ])
  })

  it('has no PR item without an open linked PR', () => {
    expect(snoozeSheetItems(monday, null).map((i) => i.key)).not.toContain('pr')
  })

  it('keeps the instant a clock-time preset showed and refuses it once passed', () => {
    const tonight = snoozeSheetItems(monday, null).find((i) => i.label === 'Tonight')!
    const before = snoozeRequestFor(tonight.choice, new Date(2026, 10, 2, 19, 59).getTime())
    expect(before).toEqual({
      ok: true,
      request: { until: new Date(2026, 10, 2, 20, 0).getTime(), preset: 'tonight', surface: 'phone' },
    })
    expect(snoozeRequestFor(tonight.choice, new Date(2026, 10, 2, 20, 1).getTime())).toEqual({
      ok: false,
      reason: 'past',
    })
  })

  it('counts a duration from the tap', () => {
    const later = snoozeSheetItems(monday, null).find((i) => i.label === 'Later today')!
    const out = snoozeRequestFor(later.choice, new Date(2026, 10, 2, 10, 0).getTime())
    expect(out.ok && out.request.until).toBe(new Date(2026, 10, 2, 13, 0).getTime())
  })

  it('sends a PR-only snooze with the PR key', () => {
    const pr = snoozeSheetItems(monday, { key: 'github:acme/app#512', number: 512 }).at(-1)!
    expect(snoozeRequestFor(pr.choice, monday.getTime())).toEqual({
      ok: true,
      request: { until: null, pr: 'github:acme/app#512', preset: 'pr', surface: 'phone' },
    })
  })
})
