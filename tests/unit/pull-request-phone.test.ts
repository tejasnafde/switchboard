/**
 * The phones' Reviews rules (`src/shared/pull-request-phone.ts`). The cases
 * also go to tests/fixtures/phone-pr-cases.json, which Android's
 * PhonePullRequestsFixtureTest runs against its port. After changing a rule,
 * regenerate it with
 *
 *   SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/pull-request-phone.test.ts
 *
 * and update the Kotlin port until its test passes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkDuration,
  checksStatus,
  checkTrailing,
  conflictsStatus,
  conversationsStatus,
  DEFAULT_PHONE_PR_FILTERS,
  diffStatLabel,
  failedChecksPill,
  filterPhonePrs,
  mergeOnDesktopNote,
  moreChecksLabel,
  needsYouCount,
  orderedChecks,
  phonePrFiltersActive,
  phonePrHostErrors,
  phonePrSections,
  phonePrSubtitle,
  prAgeLabel,
  prCheckoutCommand,
  reviewPillTurn,
  reviewsStatus,
  workOnPrCheckout,
  workOnPrPill,
  type PhonePrFilters,
} from '../../src/shared/pull-request-phone'
import { prRowStatus } from '../../src/shared/pull-request-groups'
import {
  prKey,
  rollupChecks,
  type PrCheck,
  type PrDetail,
  type PrSource,
  type PrSummary,
} from '../../src/shared/pull-requests'

const FIXTURE = join(__dirname, '../fixtures/phone-pr-cases.json')
const NOW = Date.parse('2026-10-12T12:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN

const me = { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false }
const asked = { isAuthor: false, isRequestedReviewer: true, hasReviewed: false, hasCommented: false }
const reviewed = { isAuthor: false, isRequestedReviewer: false, hasReviewed: false, hasCommented: true }
const person = (login: string) => ({ login, displayName: login, avatarUrl: null })

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: 'github', owner: 'geoiq', name: 'switchboard', number },
    title: `PR ${number}`,
    url: `https://github.com/geoiq/switchboard/pull/${number}`,
    author: person('tejas'),
    authorId: 'tejas',
    state: 'open',
    draft: false,
    sourceBranch: `feat/${number}`,
    targetBranch: 'main',
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - HOUR,
    mergedAt: null,
    additions: 184,
    deletions: 37,
    changedFiles: 6,
    unresolvedConversations: 0,
    mergeConflicts: false,
    conflictedFiles: [],
    checks: rollupChecks([{ state: 'success' }]),
    reviewers: [],
    approvals: { given: 0, required: null },
    viewer: me,
    projectPaths: ['/p/switchboard'],
    ...over,
  }
}

const bb = { host: 'bitbucket' as const, owner: 'geoiq', name: 'bb-sync' }

/** One of each row the mock shows, plus the edges the filters care about. */
const PRS: Record<string, PrSummary> = {
  failed: pr(1482, {
    title: 'Retry uploads when the signed URL expires',
    sourceBranch: 'fix/upload-retry',
    updatedAt: NOW - 12 * MIN,
    checks: rollupChecks([
      { state: 'failure' },
      { state: 'failure' },
      { state: 'pending' },
      ...Array(11).fill({ state: 'success' }),
    ]),
    unresolvedConversations: 3,
    reviewers: [
      { id: 'a', person: person('a'), state: 'changes_requested', requested: true },
      { id: 'b', person: person('b'), state: 'approved', requested: true },
    ],
    approvals: { given: 1, required: null },
  }),
  askedBb: pr(605, {
    ref: { ...bb, number: 605 },
    title: 'Bitbucket: read conflicts',
    viewer: asked,
    author: person('pankaj'),
  }),
  ready: pr(1477, { approvals: { given: 2, required: 2 } }),
  running: pr(1490, { checks: rollupChecks([{ state: 'pending' }, { state: 'success' }]), updatedAt: NOW - 5 * MIN }),
  draft: pr(1491, { draft: true, checks: rollupChecks([]) }),
  commented: pr(212, {
    ref: { host: 'github', owner: 'geoiq', name: 'saathi-bot', number: 212 },
    viewer: reviewed,
    author: person('pankaj'),
    updatedAt: NOW - 2 * 24 * HOUR,
  }),
  conflictsBb: pr(598, {
    ref: { ...bb, number: 598 },
    viewer: reviewed,
    author: person('pankaj'),
    mergeConflicts: true,
    conflictedFiles: ['src/a.ts', 'src/b.ts'],
    headFromFork: true,
  }),
  fork: pr(1500, { headFromFork: true, mergeConflicts: null, unresolvedConversations: null }),
  merged: pr(1400, { state: 'merged', mergedAt: NOW - 24 * HOUR }),
  closed: pr(1300, { state: 'closed' }),
}

const HIDDEN = [prKey(PRS.running.ref)]

const FILTER_CASES: Array<{ id: string; filters: Partial<PhonePrFilters>; query?: string }> = [
  { id: 'defaults' },
  { id: 'needs-you', filters: { show: 'needs-you' } },
  { id: 'mine', filters: { show: 'mine' } },
  { id: 'reviewing', filters: { show: 'reviewing' } },
  { id: 'failing', filters: { checks: 'failing' } },
  { id: 'running-with-hidden', filters: { checks: 'running', showHidden: true } },
  { id: 'passing', filters: { checks: 'passing' } },
  { id: 'no-drafts', filters: { showDrafts: false } },
  { id: 'without-bb-sync', filters: { excludedRepos: ['bitbucket:geoiq/bb-sync'] } },
  { id: 'query', query: '#1482' },
].map((c) => ({ ...c, filters: c.filters ?? {} }))

function check(id: string, state: PrCheck['state'], durationMs: number | null): PrCheck {
  return { id, name: id, state, description: null, url: null, durationMs, rerunId: null }
}

const CHECKS = [
  check('lint', 'success', 48_000),
  check('unit (macos-14)', 'failure', 252_000),
  check('android / assemble', 'pending', null),
  check('typecheck', 'success', 65_000),
  check('e2e / reviews', 'failure', 580_000),
  check('docs', 'skipped', null),
]

const SOURCES: Array<{ id: string; sources: PrSource[] }> = [
  {
    id: 'github-signed-out',
    sources: [
      {
        repo: { host: 'github', owner: 'geoiq', name: 'switchboard' },
        projectPaths: [],
        error: { kind: 'token_rejected', host: 'github', message: "The desktop's gh is signed out." },
      },
      {
        repo: { host: 'github', owner: 'geoiq', name: 'saathi-bot' },
        projectPaths: [],
        error: { kind: 'token_rejected', host: 'github', message: "The desktop's gh is signed out." },
      },
      { repo: bb, projectPaths: [], error: null },
    ],
  },
  {
    id: 'one-repo-not-found',
    sources: [
      { repo: { host: 'github', owner: 'geoiq', name: 'switchboard' }, projectPaths: [], error: null },
      {
        repo: { host: 'github', owner: 'geoiq', name: 'gone' },
        projectPaths: [],
        error: { kind: 'not_found', host: 'github', message: 'Not found' },
      },
    ],
  },
]

function detail(summary: PrSummary, checkList: PrCheck[]): PrDetail {
  return {
    ...summary,
    description: '',
    headSha: null,
    mergeBlockers: [],
    mergeStrategies: ['merge_commit'],
    activity: [],
    checkList,
    viewerCanManage: true,
  }
}

function cases() {
  const keyOf = (p: PrSummary) => prKey(p.ref)
  const all = Object.values(PRS)
  return {
    now: NOW,
    prs: PRS,
    hidden: HIDDEN,
    rowStatus: Object.entries(PRS).map(([id, p]) => ({ pr: id, expected: prRowStatus(p, NOW) })),
    filters: FILTER_CASES.map((c) => {
      const filters = { ...DEFAULT_PHONE_PR_FILTERS, ...c.filters }
      return {
        id: c.id,
        filters,
        query: c.query ?? '',
        active: phonePrFiltersActive(filters),
        expected: filterPhonePrs(all, HIDDEN, filters, c.query ?? '', NOW).map(keyOf),
      }
    }),
    needsYou: needsYouCount(all, HIDDEN, NOW),
    sections: (['status', 'repository'] as const).map((groupBy) => ({
      groupBy,
      expected: phonePrSections(filterPhonePrs(all, [], DEFAULT_PHONE_PR_FILTERS, '', NOW), groupBy, NOW).map((s) => ({
        key: s.key,
        title: s.title,
        rows: s.rows.map((r) => keyOf(r.pr)),
      })),
    })),
    statusCard: Object.entries(PRS).map(([id, p]) => ({
      pr: id,
      checks: checksStatus(p.checks),
      reviews: reviewsStatus(p),
      conversations: conversationsStatus(p),
      conflicts: conflictsStatus(p),
      diffStat: diffStatLabel(p),
      age: prAgeLabel(p.updatedAt, NOW),
    })),
    checks: {
      input: CHECKS,
      ordered: orderedChecks(CHECKS).map((c) => c.id),
      trailing: Object.fromEntries(CHECKS.map((c) => [c.id, checkTrailing(c)])),
      morePassed: moreChecksLabel([CHECKS[0], CHECKS[3]]),
      moreMixed: moreChecksLabel(CHECKS),
    },
    durations: [0, 48_000, 65_000, 252_000, 3_725_000].map((ms) => [ms, checkDuration(ms)]),
    ages: [0, 30_000, 12 * MIN, 3 * HOUR, 49 * HOUR].map((ago) => [ago, prAgeLabel(NOW - ago, NOW)]),
    workOnPr: Object.entries(PRS).map(([id, p]) => ({
      pr: id,
      checkout: workOnPrCheckout(p),
      command: prCheckoutCommand(p),
    })),
    hostErrors: SOURCES.map((c) => ({ id: c.id, sources: c.sources, expected: phonePrHostErrors(c.sources) })),
    pillTurns: [
      { text: '  fix the failures ', pill: { label: 'L', content: 'C' }, pillId: 'review-1' },
      { text: '', pill: { label: 'L', content: 'C' }, pillId: 'review-2' },
    ].map((c) => ({ ...c, expected: reviewPillTurn(c.text, c.pill, c.pillId) })),
    subtitles: [
      [8, [], ['github', 'bitbucket'], phonePrSubtitle(8, [], ['github', 'bitbucket'])],
      [0, [], ['github'], phonePrSubtitle(0, [], ['github'])],
      [2, ['github'], ['github', 'bitbucket'], phonePrSubtitle(2, ['github'], ['github', 'bitbucket'])],
    ],
  }
}

describe('phone pull request rules', () => {
  const all = Object.values(PRS)

  it('filters by the chips and the sheet, never listing closed or hidden PRs by default', () => {
    const keys = (f: Partial<PhonePrFilters>, query = '') =>
      filterPhonePrs(all, HIDDEN, { ...DEFAULT_PHONE_PR_FILTERS, ...f }, query, NOW).map((p) => p.ref.number)
    expect(keys({})).toEqual([1482, 605, 1477, 1491, 212, 598, 1500, 1400])
    expect(keys({ show: 'needs-you' })).toEqual([1482, 605])
    expect(keys({ show: 'reviewing' })).toEqual([605, 212, 598])
    expect(keys({ checks: 'running', showHidden: true })).toEqual([1490])
    expect(keys({ showDrafts: false })).not.toContain(1491)
    expect(keys({}, '#1482')).toEqual([1482])
    expect(needsYouCount(all, HIDDEN, NOW)).toBe(2)
    expect(phonePrFiltersActive(DEFAULT_PHONE_PR_FILTERS)).toBe(false)
    expect(phonePrFiltersActive({ ...DEFAULT_PHONE_PR_FILTERS, showDrafts: false })).toBe(true)
  })

  it('groups by status like the desktop, or by repository in status order', () => {
    const shown = filterPhonePrs(all, [], DEFAULT_PHONE_PR_FILTERS, '', NOW)
    expect(phonePrSections(shown, 'status', NOW).map((s) => s.title)).toEqual([
      'Needs you',
      'Ready to merge',
      'Your pull requests',
      'Reviewing',
      'Merged this week',
    ])
    const byRepo = phonePrSections(shown, 'repository', NOW)
    expect(byRepo.map((s) => s.title)).toEqual(['geoiq/switchboard', 'geoiq/bb-sync', 'geoiq/saathi-bot'])
    expect(byRepo[0].rows.map((r) => r.pr.ref.number)[0]).toBe(1482)
  })

  it('words the status card as the mock does', () => {
    expect(checksStatus(PRS.failed.checks)).toEqual({ text: '2 of 14 failed', tone: 'failure' })
    expect(reviewsStatus(PRS.failed)).toEqual({ text: 'Changes requested · 1 approval', tone: 'pending' })
    expect(conversationsStatus(PRS.failed)).toEqual({ text: '3 open', tone: 'pending' })
    expect(conflictsStatus(PRS.failed)).toEqual({ text: 'None with main', tone: 'success' })
    expect(conflictsStatus(PRS.conflictsBb)).toEqual({ text: '2 files', tone: 'failure' })
    expect(conflictsStatus(PRS.fork).text).toBe('Not checked yet')
    expect(diffStatLabel(PRS.failed)).toBe('+184 -37 in 6 files')
    expect(mergeOnDesktopNote('bitbucket')).toBe(
      'Reviews, comments and merges post as you on Bitbucket, so they stay on the desktop app.',
    )
    expect(mergeOnDesktopNote('github', true)).toBe(
      'Merges, closes, reviewers and re-runs stay on the desktop app. Replies, comments and reviews from this phone post as you on GitHub.',
    )
  })

  it('puts failed checks first, then running, and says what the hidden rest are', () => {
    expect(orderedChecks(CHECKS).map((c) => c.id)).toEqual([
      'unit (macos-14)',
      'e2e / reviews',
      'android / assemble',
      'lint',
      'typecheck',
      'docs',
    ])
    expect(checkTrailing(CHECKS[1])).toBe('failed · 4m 12s')
    expect(checkTrailing(CHECKS[2])).toBe('running')
    expect(checkTrailing(CHECKS[3])).toBe('1m 05s')
    expect(moreChecksLabel([CHECKS[0], CHECKS[3]])).toBe('+ 2 more passed')
  })

  it('checks out a PR head by branch, a GitHub fork through refs/pull, and gives up on a Bitbucket fork', () => {
    const repo = { host: 'github', owner: 'geoiq', name: 'switchboard' }
    expect(workOnPrCheckout(PRS.failed)).toEqual({ name: 'fix/upload-retry', fetch: { repo, ref: 'fix/upload-retry' } })
    expect(workOnPrCheckout(PRS.fork)).toEqual({ name: 'pr-1500', fetch: { repo, ref: 'refs/pull/1500/head' } })
    expect(workOnPrCheckout(PRS.conflictsBb)).toBeNull()
    expect(prCheckoutCommand(PRS.askedBb)).toBe('bbpr 605')
  })

  it('builds the review pill, asking for a checkout only in the project checkout', () => {
    const d = detail(PRS.failed, CHECKS)
    const onBranch = workOnPrPill(d, 'worktree')
    expect(onBranch.label).toBe('2 failed checks · #1482 · unit (macos-14), e2e / reviews')
    expect(onBranch.content).toContain('worktree on the pull request')
    expect(onBranch.content).not.toContain('gh pr checkout')
    expect(workOnPrPill(d, 'checkout').content).toContain('run `gh pr checkout 1482`')
    expect(workOnPrPill(d, 'attached').content).not.toContain('worktree')
    expect(failedChecksPill(detail(PRS.ready, [check('lint', 'success', 1)]))).toBeNull()
  })

  it('sends a review pill as a chip before the text, its content in the provider text', () => {
    expect(reviewPillTurn(' go ', { label: 'L', content: 'C' }, 'r1')).toEqual({
      displayBody: '[[pill:r1]] go',
      providerText: 'C\n\ngo',
      pillsMeta: { r1: { label: 'L', kind: 'review' } },
    })
  })

  it('shows one card for a host-wide failure and none for a repository it cannot see', () => {
    expect(phonePrHostErrors(SOURCES[0].sources)).toEqual([
      { host: 'github', title: "Couldn't read GitHub", message: "The desktop's gh is signed out." },
    ])
    expect(phonePrHostErrors(SOURCES[1].sources)).toEqual([])
    expect(phonePrSubtitle(2, ['github'], ['github', 'bitbucket'])).toBe('showing Bitbucket only')
  })

  it('keeps tests/fixtures/phone-pr-cases.json equal to the rules', () => {
    const expected = `${JSON.stringify(cases(), null, 2)}\n`
    if (process.env.SB_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, expected)
    expect(
      readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
      'tests/fixtures/phone-pr-cases.json is stale: run SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/pull-request-phone.test.ts',
    ).toBe(expected)
  })
})
