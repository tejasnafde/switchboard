/** Which Home > Recents rows take Settle: the shared fixture's cases, as native Android runs them. */
import { canSettle, homeRecents, type HomeRecentRow, type HomeRecentStatus } from '../home-recents'

const cases = require('../../../../../tests/fixtures/chat-settle-cases.json') as {
  canSettle: { status: string | null; expect: boolean }[]
}

function row(status: string | null, settleable = true): HomeRecentRow {
  return {
    id: 't1',
    title: 'Fix the build',
    startedAt: 100,
    projectPath: '/repo',
    projectName: 'repo',
    connectionId: 'mac',
    connectionLabel: 'Mac',
    status: status as HomeRecentStatus | null,
    unread: 0,
    snoozable: true,
    settleable,
    woke: false,
  }
}

it.each(cases.canSettle)('a $status row can settle: $expect', ({ status, expect: settles }) => {
  expect(canSettle(row(status))).toBe(settles)
})

it('offers no Settle from a backend without chat_settle_v1', () => {
  expect(canSettle(row(null, false))).toBe(false)
  expect(canSettle(row('Done', false))).toBe(false)
})

it('marks the rows of a machine that announced the capability', () => {
  const session = { id: 'a', title: 'A', startedAt: 1, projectPath: '/p', projectName: 'p' }
  const page = homeRecents(
    [
      { connectionId: 'new', label: 'New', connected: true, sessions: [session], settle: true },
      { connectionId: 'old', label: 'Old', connected: true, sessions: [session] },
    ],
    {},
  )
  expect(Object.fromEntries(page.items.map((r) => [r.connectionId, canSettle(r)]))).toEqual({ new: true, old: false })
})
