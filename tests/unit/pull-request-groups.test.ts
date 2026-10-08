/**
 * The Reviews grouping rule: which group each pull request sits in and the
 * one status phrase its row shows.
 */
import { describe, expect, it } from 'vitest'
import {
  applyHidden,
  filterPullRequests,
  groupPullRequests,
  groupPullRequestsByRepo,
  hiddenComesBack,
  MERGED_WINDOW_MS,
  prRowStatus,
  toggleCollapsed,
} from '../../src/shared/pull-request-groups'
import { mergeBlockers, rollupChecks, type PrSummary } from '../../src/shared/pull-requests'

const NOW = Date.parse('2026-09-27T12:00:00Z')
const HOUR = 3_600_000

function pr(over: Partial<PrSummary> = {}, number = 1): PrSummary {
  return {
    ref: { host: 'github', owner: 'o', name: 'repo', number },
    title: `PR ${number}`,
    url: '',
    author: { login: 'me', displayName: 'Me', avatarUrl: null },
    state: 'open',
    draft: false,
    sourceBranch: 'feat',
    targetBranch: 'main',
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - HOUR,
    mergedAt: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    unresolvedConversations: 0,
    mergeConflicts: false,
    conflictedFiles: [],
    checks: rollupChecks([{ state: 'success' }]),
    reviewers: [],
    approvals: { given: 1, required: 1 },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
    projectPaths: [],
    ...over,
  }
}

const reviewer = { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false }
const person = { login: 'p', displayName: 'p', avatarUrl: null }

describe('prRowStatus', () => {
  it.each<[string, Partial<PrSummary>, string, string, string]>([
    ['asked to review', { viewer: reviewer }, 'needs-you', 'review', 'your review'],
    [
      'your PR with a failed build',
      { checks: rollupChecks([{ state: 'failure' }, { state: 'success' }]) },
      'needs-you',
      'failed',
      'build failed',
    ],
    [
      'your PR with open conversations',
      { unresolvedConversations: 3 },
      'needs-you',
      'conversation',
      '3 open conversations',
    ],
    [
      'your PR with one open conversation',
      { unresolvedConversations: 1 },
      'needs-you',
      'conversation',
      '1 open conversation',
    ],
    [
      'your PR with changes requested',
      { reviewers: [{ person, state: 'changes_requested', requested: true }] },
      'needs-you',
      'conversation',
      'changes requested',
    ],
    [
      'your PR with checks running',
      { checks: rollupChecks([{ state: 'pending' }]) },
      'yours',
      'running',
      'checks running',
    ],
    ['your PR short of approvals', { approvals: { given: 0, required: 2 } }, 'yours', 'waiting', '0 of 2 approvals'],
    [
      'your PR, no rule, no approval yet',
      { approvals: { given: 0, required: null } },
      'yours',
      'waiting',
      'waiting for review',
    ],
    ['your draft', { draft: true, checks: rollupChecks([{ state: 'failure' }]) }, 'yours', 'draft', 'draft'],
    ['your PR, approved, green', {}, 'ready', 'ready', ''],
    ['your PR, approved, no checks at all', { checks: rollupChecks([]) }, 'ready', 'ready', ''],
    [
      "someone else's you already reviewed",
      { viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: true, hasCommented: false } },
      'reviewing',
      'waiting',
      'you reviewed',
    ],
    [
      "someone else's, checks running",
      {
        viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: true, hasCommented: false },
        checks: rollupChecks([{ state: 'pending' }]),
      },
      'reviewing',
      'running',
      'checks running',
    ],
    [
      "someone else's you only commented on",
      { viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: true } },
      'reviewing',
      'waiting',
      'you commented',
    ],
    ['merged yesterday', { state: 'merged', mergedAt: NOW - 24 * HOUR }, 'merged', 'merged', ''],
  ])('%s', (_name, over, group, icon, phrase) => {
    expect(prRowStatus(pr(over), NOW)).toEqual({ group, icon, phrase })
  })

  it('a failed build outranks open conversations on your PR', () => {
    expect(
      prRowStatus(pr({ checks: rollupChecks([{ state: 'failure' }]), unresolvedConversations: 2 }), NOW)?.phrase,
    ).toBe('build failed')
  })

  it("a review request outranks a failing build on someone else's PR", () => {
    expect(prRowStatus(pr({ viewer: reviewer, checks: rollupChecks([{ state: 'failure' }]) }), NOW)?.group).toBe(
      'needs-you',
    )
  })

  it('does not list closed PRs, or merges older than a week', () => {
    expect(prRowStatus(pr({ state: 'closed' }), NOW)).toBeNull()
    expect(prRowStatus(pr({ state: 'merged', mergedAt: NOW - MERGED_WINDOW_MS - 1 }), NOW)).toBeNull()
    expect(prRowStatus(pr({ state: 'merged', mergedAt: null }), NOW)).toBeNull()
  })

  it('agrees with the merge blockers: nothing reaches Ready with a blocker', () => {
    const ready = pr({ approvals: { given: 2, required: 2 } })
    expect(mergeBlockers(ready)).toEqual([])
    expect(prRowStatus(ready, NOW)?.group).toBe('ready')
  })
})

describe('groupPullRequests', () => {
  it('orders groups by what you do next, drops empty ones, newest first inside', () => {
    const groups = groupPullRequests(
      [
        pr({ state: 'merged', mergedAt: NOW - 3 * 24 * HOUR }, 10),
        pr({}, 11),
        pr({ viewer: reviewer, updatedAt: NOW - 3 * HOUR }, 12),
        pr({ unresolvedConversations: 1, updatedAt: NOW - HOUR }, 13),
        pr({ state: 'merged', mergedAt: NOW - 24 * HOUR }, 14),
        pr({ state: 'closed' }, 15),
      ],
      NOW,
    )
    expect(groups.map((g) => [g.label, g.prs.map((p) => p.pr.ref.number)])).toEqual([
      ['Needs you', [13, 12]],
      ['Ready to merge', [11]],
      ['Merged this week', [14, 10]],
    ])
  })

  it('keeps your own waiting PRs apart from the ones you only review, yours first', () => {
    const other = { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: false }
    const groups = groupPullRequests(
      [
        pr({ viewer: { ...other, hasCommented: true }, updatedAt: NOW - 10 * 60_000 }, 20),
        pr({ approvals: { given: 0, required: null }, reviewers: [], updatedAt: NOW - 5 * HOUR }, 21),
        pr({ viewer: { ...other, hasReviewed: true }, updatedAt: NOW - 2 * HOUR }, 22),
        pr({ draft: true, updatedAt: NOW - 3 * HOUR }, 23),
        pr({}, 24),
        pr({ viewer: reviewer }, 25),
        pr({ state: 'merged', mergedAt: NOW - HOUR }, 26),
      ],
      NOW,
    )
    expect(groups.map((g) => [g.id, g.label, g.prs.map((p) => [p.pr.ref.number, p.status.phrase])])).toEqual([
      ['needs-you', 'Needs you', [[25, 'your review']]],
      ['ready', 'Ready to merge', [[24, '']]],
      [
        'yours',
        'Your pull requests',
        [
          [23, 'draft'],
          [21, 'waiting for review'],
        ],
      ],
      [
        'reviewing',
        'Reviewing',
        [
          [20, 'you commented'],
          [22, 'you reviewed'],
        ],
      ],
      ['merged', 'Merged this week', [[26, '']]],
    ])
  })
})

describe('filterPullRequests', () => {
  const list = [
    pr({ title: 'Kanban card cost cap' }, 161),
    pr({ title: 'Doctor alert dedupe', ref: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-doctor', number: 40 } }),
  ]

  it('matches title, repo, owner and number (with or without #)', () => {
    expect(filterPullRequests(list, 'kanban').map((p) => p.ref.number)).toEqual([161])
    expect(filterPullRequests(list, 'ssg-doc').map((p) => p.ref.number)).toEqual([40])
    expect(filterPullRequests(list, '#40').map((p) => p.ref.number)).toEqual([40])
    expect(filterPullRequests(list, '  ')).toHaveLength(2)
  })
})

describe('merge conflicts in the list', () => {
  it('puts your conflicted PR in Needs you, ahead of a failed build', () => {
    const conflicted = pr({ mergeConflicts: true, checks: rollupChecks([{ state: 'failure' }]) })
    expect(prRowStatus(conflicted, NOW)).toEqual({ group: 'needs-you', icon: 'conflict', phrase: 'merge conflicts' })
    expect(mergeBlockers(conflicted).map((b) => b.label)).toEqual(['Conflicts with main', '1 check failed'])
  })

  it("says so on someone else's PR too, unless your review is what is owed", () => {
    expect(prRowStatus(pr({ mergeConflicts: true, viewer: { ...reviewer, isRequestedReviewer: false } }), NOW)).toEqual(
      { group: 'reviewing', icon: 'conflict', phrase: 'merge conflicts' },
    )
    expect(prRowStatus(pr({ mergeConflicts: true, viewer: reviewer }), NOW)?.phrase).toBe('your review')
  })

  it('treats a conflict the host has not worked out yet as none', () => {
    expect(prRowStatus(pr({ mergeConflicts: null }), NOW)?.icon).toBe('ready')
  })
})

describe('groupPullRequestsByRepo', () => {
  const at = (owner: string, name: string, number: number, over: Partial<PrSummary> = {}) =>
    pr({ ...over, ref: { host: 'bitbucket', owner, name, number } }, number)
  const prs = [
    at('geoiq', 'retailiq', 88, { approvals: { given: 0, required: 2 } }),
    at('geoiq', 'ssg-bot-v2', 605, { approvals: { given: 0, required: 2 }, updatedAt: NOW - 3 * HOUR }),
    at('geoiq', 'ssg-bot-v2', 612, { mergeConflicts: true }),
    at('geoiq', 'ssg-bot-v2', 618, { viewer: reviewer, updatedAt: NOW - 2 * HOUR }),
    at('geoiq', 'ssg-bot-v2', 500, { state: 'closed' }),
  ]

  it('keeps the status order inside each repository and puts the one that needs you first', () => {
    const sections = groupPullRequestsByRepo(prs, NOW, [], false)
    expect(sections.map((s) => [s.label, s.count])).toEqual([
      ['geoiq / ssg-bot-v2', 3],
      ['geoiq / retailiq', 1],
    ])
    // Needs you (612 newest, then 618), then Your pull requests (605); the closed one is not listed.
    expect(sections[0].prs.map((r) => r.pr.ref.number)).toEqual([612, 618, 605])
  })

  it('puts a repository with your waiting PR ahead of one you only review', () => {
    const commented = { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: true }
    const sections = groupPullRequestsByRepo(
      [
        at('geoiq', 'ssg-doctor', 41, { viewer: commented, updatedAt: NOW - 60_000 }),
        at('geoiq', 'retailiq', 88, { approvals: { given: 0, required: null }, updatedAt: NOW - 5 * HOUR }),
      ],
      NOW,
      [],
      false,
    )
    expect(sections.map((s) => s.label)).toEqual(['geoiq / retailiq', 'geoiq / ssg-doctor'])
  })

  it('draws no rows for a collapsed repository but keeps its count', () => {
    const collapsed = toggleCollapsed([], 'bitbucket:geoiq/ssg-bot-v2')
    const [bot, retail] = groupPullRequestsByRepo(prs, NOW, collapsed, false)
    expect([bot.collapsed, bot.count, bot.prs]).toEqual([true, 3, []])
    expect(retail.collapsed).toBe(false)
    expect(toggleCollapsed(collapsed, 'bitbucket:geoiq/ssg-bot-v2')).toEqual([])
  })

  it('shows the matches of a filter even in a collapsed repository', () => {
    const [bot] = groupPullRequestsByRepo(filterPullRequests(prs, '612'), NOW, ['bitbucket:geoiq/ssg-bot-v2'], true)
    expect(bot.prs.map((r) => r.pr.ref.number)).toEqual([612])
  })
})

describe('hidden pull requests', () => {
  const hiddenAt = NOW - 2 * HOUR

  it('stays hidden while nothing changed, or while it changed but does not need you', () => {
    expect(hiddenComesBack(pr({ updatedAt: hiddenAt - 1, viewer: reviewer }), hiddenAt, NOW)).toBe(false)
    expect(hiddenComesBack(pr({ updatedAt: NOW }), hiddenAt, NOW)).toBe(false)
    expect(hiddenComesBack(pr({ updatedAt: NOW, approvals: { given: 0, required: 2 } }), hiddenAt, NOW)).toBe(false)
    expect(
      hiddenComesBack(
        pr({ updatedAt: NOW, viewer: { ...reviewer, isRequestedReviewer: false, hasCommented: true } }),
        hiddenAt,
        NOW,
      ),
    ).toBe(false)
  })

  it('comes back once it changed after hiding and needs you', () => {
    // Someone asked for your review again.
    expect(hiddenComesBack(pr({ updatedAt: NOW, viewer: reviewer }), hiddenAt, NOW)).toBe(true)
    // Your build broke.
    expect(hiddenComesBack(pr({ updatedAt: NOW, checks: rollupChecks([{ state: 'failure' }]) }), hiddenAt, NOW)).toBe(
      true,
    )
  })

  it('splits the stored hides of one list read into still hidden and came back', () => {
    const quiet = pr({ updatedAt: hiddenAt - 1 }, 1)
    const back = pr({ updatedAt: NOW, viewer: reviewer }, 2)
    const stored = new Map([
      ['github:o/repo#1', hiddenAt],
      ['github:o/repo#2', hiddenAt],
      ['github:o/gone#9', hiddenAt],
    ])
    // A hide whose PR is not in this read (a host error, merged long ago) is left alone.
    expect(applyHidden([quiet, back, pr({}, 3)], stored, NOW)).toEqual({
      hidden: ['github:o/repo#1'],
      cameBack: ['github:o/repo#2'],
    })
  })
})
