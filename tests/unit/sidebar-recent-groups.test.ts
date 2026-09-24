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
    expect(['approval', 'input', 'plan', 'failed'].map((s) => recentDot(s as RecentSessionStatus))).toEqual(
      ['needs-you', 'needs-you', 'needs-you', 'needs-you'],
    )
    expect(recentDot('working')).toBe('working')
    expect(recentDot('done')).toBe('finished')
    expect(recentDot(undefined)).toBe('idle')
  })
})

describe('groupRecentSessions', () => {
  it('keeps needs-you and working in full and fills the rest of the limit with done', () => {
    const result = groupRecentSessions(rows(['approval', 'working', 'done', undefined, undefined, undefined]), 4, 0)
    expect(ids(result)).toEqual([['needs-you', [0]], ['working', [1]], ['done', [2, 3]]])
    expect(result.hiddenCount).toBe(2)
    expect(result.nextRevealCount).toBe(2)
  })

  it('never hides a chat that needs you behind Show more, even past the limit', () => {
    const result = groupRecentSessions(rows(['approval', 'input', 'plan', 'failed', 'working', undefined]), 4, 0)
    expect(ids(result)).toEqual([['needs-you', [0, 1, 2, 3]], ['working', [4]]])
    expect(result.hiddenCount).toBe(1)
  })

  it('reveals done chats five at a time and stops at the end', () => {
    const items = rows(Array.from({ length: 18 }, () => undefined))
    expect(groupRecentSessions(items, 6, 0)).toMatchObject({ hiddenCount: 12, nextRevealCount: 5 })
    expect(groupRecentSessions(items, 6, 5)).toMatchObject({ hiddenCount: 7, nextRevealCount: 10 })
    expect(groupRecentSessions(items, 6, 10)).toMatchObject({ hiddenCount: 2, nextRevealCount: 12 })
    expect(groupRecentSessions(items, 6, 12).hiddenCount).toBe(0)
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
