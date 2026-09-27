/**
 * The Reviews grouping rule: which group each pull request sits in and the
 * one status phrase its row shows.
 */
import { describe, expect, it } from 'vitest'
import { filterPullRequests, groupPullRequests, MERGED_WINDOW_MS, prRowStatus } from '../../src/shared/pull-request-groups'
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
    checks: rollupChecks([{ state: 'success' }]),
    reviewers: [],
    approvals: { given: 1, required: 1 },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false },
    projectPaths: [],
    ...over,
  }
}

const reviewer = { isAuthor: false, isRequestedReviewer: true, hasReviewed: false }
const person = { login: 'p', displayName: 'p', avatarUrl: null }

describe('prRowStatus', () => {
  it.each<[string, Partial<PrSummary>, string, string, string]>([
    ['asked to review', { viewer: reviewer }, 'needs-you', 'review', 'your review'],
    ['your PR with a failed build', { checks: rollupChecks([{ state: 'failure' }, { state: 'success' }]) }, 'needs-you', 'failed', 'build failed'],
    ['your PR with open conversations', { unresolvedConversations: 3 }, 'needs-you', 'conversation', '3 open conversations'],
    ['your PR with one open conversation', { unresolvedConversations: 1 }, 'needs-you', 'conversation', '1 open conversation'],
    ['your PR with changes requested', { reviewers: [{ person, state: 'changes_requested', requested: true }] }, 'needs-you', 'conversation', 'changes requested'],
    ['your PR with checks running', { checks: rollupChecks([{ state: 'pending' }]) }, 'waiting', 'running', 'checks running'],
    ['your PR short of approvals', { approvals: { given: 0, required: 2 } }, 'waiting', 'waiting', '0 of 2 approvals'],
    ['your PR, no rule, no approval yet', { approvals: { given: 0, required: null } }, 'waiting', 'waiting', 'waiting for review'],
    ['your draft', { draft: true, checks: rollupChecks([{ state: 'failure' }]) }, 'waiting', 'draft', 'draft'],
    ['your PR, approved, green', {}, 'ready', 'ready', ''],
    ['your PR, approved, no checks at all', { checks: rollupChecks([]) }, 'ready', 'ready', ''],
    ['someone else\'s you already reviewed', { viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: true } }, 'waiting', 'waiting', 'you reviewed'],
    ['someone else\'s, checks running', { viewer: { isAuthor: false, isRequestedReviewer: false, hasReviewed: true }, checks: rollupChecks([{ state: 'pending' }]) }, 'waiting', 'running', 'checks running'],
    ['merged yesterday', { state: 'merged', mergedAt: NOW - 24 * HOUR }, 'merged', 'merged', ''],
  ])('%s', (_name, over, group, icon, phrase) => {
    expect(prRowStatus(pr(over), NOW)).toEqual({ group, icon, phrase })
  })

  it('a failed build outranks open conversations on your PR', () => {
    expect(prRowStatus(pr({ checks: rollupChecks([{ state: 'failure' }]), unresolvedConversations: 2 }), NOW)?.phrase).toBe('build failed')
  })

  it('a review request outranks a failing build on someone else\'s PR', () => {
    expect(prRowStatus(pr({ viewer: reviewer, checks: rollupChecks([{ state: 'failure' }]) }), NOW)?.group).toBe('needs-you')
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
    const groups = groupPullRequests([
      pr({ state: 'merged', mergedAt: NOW - 3 * 24 * HOUR }, 10),
      pr({}, 11),
      pr({ viewer: reviewer, updatedAt: NOW - 3 * HOUR }, 12),
      pr({ unresolvedConversations: 1, updatedAt: NOW - HOUR }, 13),
      pr({ state: 'merged', mergedAt: NOW - 24 * HOUR }, 14),
      pr({ state: 'closed' }, 15),
    ], NOW)
    expect(groups.map((g) => [g.label, g.prs.map((p) => p.pr.ref.number)])).toEqual([
      ['Needs you', [13, 12]],
      ['Ready to merge', [11]],
      ['Merged this week', [14, 10]],
    ])
  })
})

describe('filterPullRequests', () => {
  const list = [pr({ title: 'Kanban card cost cap' }, 161), pr({ title: 'Doctor alert dedupe', ref: { host: 'bitbucket', owner: 'geoiq', name: 'ssg-doctor', number: 40 } })]

  it('matches title, repo, owner and number (with or without #)', () => {
    expect(filterPullRequests(list, 'kanban').map((p) => p.ref.number)).toEqual([161])
    expect(filterPullRequests(list, 'ssg-doc').map((p) => p.ref.number)).toEqual([40])
    expect(filterPullRequests(list, '#40').map((p) => p.ref.number)).toEqual([40])
    expect(filterPullRequests(list, '  ')).toHaveLength(2)
  })
})
