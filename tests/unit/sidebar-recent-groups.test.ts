import { describe, expect, it } from 'vitest'
import {
  countLabel,
  groupRecentSessions,
  localMachineSummary,
  recentDot,
} from '../../src/renderer/components/sidebar/recent-groups'
import type { RecentSessionStatus } from '../../src/renderer/components/sidebar/recent-sessions'

const rows = (statuses: Array<RecentSessionStatus | undefined>) => statuses.map((status, id) => ({ id, status }))
const ids = (result: ReturnType<typeof groupRecentSessions<{ id: number; status?: RecentSessionStatus }>>) =>
  result.groups.map((group) => [group.key, group.items.map((item) => item.id)])

describe('recentDot', () => {
  it('maps every waiting state and an error to needs-you', () => {
    expect(['approval', 'input', 'plan', 'failed'].map((s) => recentDot(s as RecentSessionStatus))).toEqual([
      'needs-you',
      'needs-you',
      'needs-you',
      'needs-you',
    ])
    expect(recentDot('working')).toBe('working')
    expect(recentDot('done')).toBe('finished')
    expect(recentDot(undefined)).toBe('idle')
  })
})

describe('groupRecentSessions', () => {
  it('keeps needs-you and working in full and fills the rest of the limit with done', () => {
    const result = groupRecentSessions(rows(['approval', 'working', 'done', undefined, undefined, undefined]), 4, 0)
    expect(ids(result)).toEqual([
      ['needs-you', [0]],
      ['working', [1]],
      ['done', [2, 3]],
    ])
    expect(result.hiddenCount).toBe(2)
    expect(result.nextRevealCount).toBe(2)
  })

  it('never hides a chat that needs you behind Show more, even past the limit', () => {
    const result = groupRecentSessions(rows(['approval', 'input', 'plan', 'failed', 'working', undefined]), 4, 0)
    expect(ids(result)).toEqual([
      ['needs-you', [0, 1, 2, 3]],
      ['working', [4]],
    ])
    expect(result.hiddenCount).toBe(1)
  })

  it('reveals done chats five at a time and stops at the end', () => {
    const items = rows(Array.from({ length: 18 }, () => undefined))
    expect(groupRecentSessions(items, 6, 0)).toMatchObject({ hiddenCount: 12, nextRevealCount: 5 })
    expect(groupRecentSessions(items, 6, 5)).toMatchObject({ hiddenCount: 7, nextRevealCount: 10 })
    expect(groupRecentSessions(items, 6, 10)).toMatchObject({ hiddenCount: 2, nextRevealCount: 12 })
    expect(groupRecentSessions(items, 6, 12).hiddenCount).toBe(0)
  })

  it('leaves a settled chat out of Done recently only', () => {
    const settled = { startedAt: 100, settledAt: 200 }
    const items = [
      { id: 0, status: 'working' as const, session: settled },
      { id: 1, status: 'approval' as const, session: settled },
      { id: 2, status: 'done' as const, session: settled },
      { id: 3, status: undefined, session: settled },
      { id: 4, status: undefined, session: { startedAt: 100, settledAt: null } },
    ]
    expect(groupRecentSessions(items, 6, 0).groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['needs-you', [1]],
      ['working', [0]],
      ['done', [4]],
    ])
  })

  it('keeps a settled chat out after an edit moves its activity time, and shows it once unsettled', () => {
    const renamed = [{ id: 0, status: undefined, session: { startedAt: 300, settledAt: 200 } }]
    expect(groupRecentSessions(renamed, 6, 0).groups).toEqual([])
    const unsettled = [{ id: 0, status: 'done' as const, session: { startedAt: 300, settledAt: null } }]
    expect(groupRecentSessions(unsettled, 6, 0).groups.map((g) => g.key)).toEqual(['done'])
  })

  it('does not count settled chats against the limit or Show more', () => {
    const items = Array.from({ length: 8 }, (_, id) => ({
      id,
      status: undefined,
      session: { startedAt: 100, settledAt: id < 4 ? 200 : null },
    }))
    expect(groupRecentSessions(items, 4, 0)).toMatchObject({ hiddenCount: 0 })
  })

  it('drops empty groups', () => {
    expect(ids(groupRecentSessions(rows([undefined]), 4, 0))).toEqual([['done', [0]]])
  })
})

describe('count labels', () => {
  it('names the noun and pluralises it', () => {
    expect(countLabel(1, 'project')).toBe('1 project')
    expect(countLabel(14, 'project')).toBe('14 projects')
    expect(countLabel(0, 'thread')).toBe('0 threads')
  })

  it('summarises the local machine, leaving out workspaces when there are none', () => {
    expect(localMachineSummary(7, 69)).toBe('7 workspaces, 69 projects')
    expect(localMachineSummary(1, 1)).toBe('1 workspace, 1 project')
    expect(localMachineSummary(0, 3)).toBe('3 projects')
  })
})

describe('the Snoozed group and woken rows', () => {
  type Row = {
    id: string
    status?: RecentSessionStatus
    session: {
      snoozedAt?: number | null
      snoozedUntil?: number | null
      wokeAt?: number | null
      settledAt?: number | null
    }
  }
  const row = (id: string, status: RecentSessionStatus | undefined, session: Row['session'] = {}): Row => ({
    id,
    status,
    session,
  })
  const keys = (result: ReturnType<typeof groupRecentSessions<Row>>) =>
    result.groups.map((group) => [group.key, group.items.map((item) => item.id)])

  it('holds a snoozed chat whatever its live status, soonest wake first and PR-only last', () => {
    const result = groupRecentSessions(
      [
        row('pr', undefined, { snoozedAt: 1, snoozedUntil: null }),
        row('working', 'working', { snoozedAt: 1, snoozedUntil: 300 }),
        row('soon', 'done', { snoozedAt: 1, snoozedUntil: 100 }),
        row('live', 'working'),
      ],
      4,
      0,
    )
    expect(keys(result)).toEqual([
      ['working', ['live']],
      ['snoozed', ['soon', 'working', 'pr']],
    ])
  })

  it('does not count snoozed rows toward the limit or hide them behind Show more', () => {
    const snoozed = Array.from({ length: 6 }, (_, i) => row(`s${i}`, undefined, { snoozedAt: 1, snoozedUntil: i }))
    const result = groupRecentSessions([...snoozed, row('d1', undefined), row('d2', undefined)], 2, 0)
    expect(result.hiddenCount).toBe(0)
    expect(keys(result)).toEqual([
      ['done', ['d1', 'd2']],
      ['snoozed', ['s0', 's1', 's2', 's3', 's4', 's5']],
    ])
  })

  it('sorts a woken Done row first and never hides it behind Show more', () => {
    const items = [row('a', undefined), row('b', undefined), row('c', undefined), row('woke', undefined, { wokeAt: 5 })]
    const result = groupRecentSessions(items, 1, 0)
    expect(keys(result)).toEqual([['done', ['woke']]])
    expect(result.hiddenCount).toBe(3)
    const two = groupRecentSessions([...items, row('woke2', undefined, { wokeAt: 6 })], 1, 0)
    expect(keys(two)).toEqual([['done', ['woke', 'woke2']]])
  })

  it('keeps a woken Needs you or Working row in its own group and place', () => {
    const result = groupRecentSessions(
      [row('w1', 'working'), row('w2', 'working', { wokeAt: 5 }), row('n', 'approval', { wokeAt: 5 })],
      4,
      0,
    )
    expect(keys(result)).toEqual([
      ['needs-you', ['n']],
      ['working', ['w1', 'w2']],
    ])
  })
})
