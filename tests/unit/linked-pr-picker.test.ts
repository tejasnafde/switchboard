import { describe, expect, it } from 'vitest'
import type { PrLink } from '../../src/shared/pull-request-links'
import { rollupChecks, type PrListData, type PrSummary } from '../../src/shared/pull-requests'
import {
  LINKED_PR_ROW_CAP,
  capLinkedPrRows,
  chipCounts,
  chipIconRow,
  filterLinkedPrRows,
  linkedPrRow,
  rowDetail,
  rowTitle,
  rowTooltip,
  sortLinkedPrRows,
  spansRepos,
} from '../../src/renderer/components/reviews/linked-pr-picker'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const HOUR = 3_600_000

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: 'github', owner: 'o', name: 'repo', number },
    title: `PR ${number}`,
    url: '',
    author: { login: 'me', displayName: 'Me', avatarUrl: null },
    authorId: 'me',
    state: 'open',
    draft: false,
    sourceBranch: `feat/branch-${number}`,
    targetBranch: 'main',
    createdAt: NOW - (1000 - number) * HOUR,
    updatedAt: NOW,
    mergedAt: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    unresolvedConversations: 0,
    mergeConflicts: false,
    conflictedFiles: [],
    checks: rollupChecks([{ state: 'success' }]),
    reviewers: [],
    approvals: { given: 0, required: null },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
    projectPaths: [],
    ...over,
  }
}

function link(number: number, over: Partial<PrLink> = {}): PrLink {
  return { ref: { host: 'github', owner: 'o', name: 'repo', number }, source: 'auto', linkedAt: NOW, ...over }
}

function listOf(prs: PrSummary[]): PrListData {
  return { prs, sources: [], unsupportedProjects: [], fetchedAt: NOW, hidden: [] }
}

function rowsFor(prs: PrSummary[], links: PrLink[] = prs.map((p) => link(p.ref.number))) {
  const list = listOf(prs)
  return sortLinkedPrRows(links.map((l) => linkedPrRow(l, list)))
}

const numbers = (rows: { link: PrLink }[]) => rows.map((row) => row.link.ref.number)

describe('sortLinkedPrRows', () => {
  it('puts open PRs (drafts too) first, then the newest', () => {
    const rows = rowsFor([
      pr(5, { state: 'merged', createdAt: NOW }),
      pr(3, { createdAt: NOW - 3 * HOUR }),
      pr(4, { draft: true, createdAt: NOW - HOUR }),
      pr(2, { state: 'closed', createdAt: NOW - 2 * HOUR }),
    ])
    expect(numbers(rows)).toEqual([4, 3, 5, 2])
  })

  it('orders a PR the list lacks by its link time', () => {
    const list = listOf([pr(7, { state: 'merged', createdAt: NOW - 5 * HOUR })])
    const rows = sortLinkedPrRows(
      [link(7), link(9, { state: 'merged', linkedAt: NOW - HOUR })].map((l) => linkedPrRow(l, list)),
    )
    expect(numbers(rows)).toEqual([9, 7])
  })

  it("uses the link's newer state over the list's", () => {
    const rows = rowsFor([pr(1), pr(2)], [link(1, { state: 'merged', stateAt: NOW + 1 }), link(2)])
    expect(numbers(rows)).toEqual([2, 1])
    expect(rows[1].state).toBe('merged')
  })
})

describe('row text', () => {
  it('shows the title first and "#n · state" then the phrases', () => {
    const [row] = rowsFor([
      pr(612, { title: 'Retry with jitter', unresolvedConversations: 3, checks: rollupChecks([{ state: 'failure' }]) }),
    ])
    expect(rowTitle(row)).toBe('Retry with jitter')
    expect(rowDetail(row, false)).toEqual([
      { text: '#612' },
      { text: 'open' },
      { text: 'build failed', bad: true },
      { text: '3 open conversations' },
    ])
  })

  it('says draft and checks running', () => {
    const [draft] = rowsFor([pr(1, { draft: true, checks: rollupChecks([{ state: 'pending' }]) })])
    expect(rowDetail(draft, false).map((p) => p.text)).toEqual(['#1', 'open', 'draft'])
    const [running] = rowsFor([pr(2, { checks: rollupChecks([{ state: 'pending' }]) })])
    expect(rowDetail(running, false).map((p) => p.text)).toEqual(['#2', 'open', 'checks running'])
  })

  it('gives a merged PR no open-only phrases', () => {
    const [row] = rowsFor([pr(3, { state: 'merged', unresolvedConversations: 2 })])
    expect(rowDetail(row, false).map((p) => p.text)).toEqual(['#3', 'merged'])
  })

  it('names the repository only when the chat spans several', () => {
    const other = pr(1, { ref: { host: 'github', owner: 'o', name: 'other', number: 1 } })
    const single = rowsFor([pr(1), pr(2)])
    expect(spansRepos(single)).toBe(false)
    const multi = rowsFor([pr(2), other], [link(2), { ...link(1), ref: other.ref }])
    expect(spansRepos(multi)).toBe(true)
    expect(rowDetail(multi[1], true).map((p) => p.text)).toContain('o/other')
  })

  it('shows how a PR was linked unless automatically; the tooltip always says it', () => {
    const rows = rowsFor([pr(1), pr(2)], [link(1, { source: 'manual' }), link(2)])
    const manual = rows.find((r) => r.link.ref.number === 1)!
    const auto = rows.find((r) => r.link.ref.number === 2)!
    expect(rowDetail(manual, false).map((p) => p.text)).toContain('Linked by you')
    expect(rowDetail(auto, false).map((p) => p.text)).not.toContain('Linked automatically')
    expect(rowTooltip(auto)).toBe('Linked automatically · feat/branch-2')
  })

  it('falls back to the repository while the list lacks the PR', () => {
    const row = linkedPrRow(link(8), null)
    expect(rowTitle(row)).toBe('o/repo')
    expect(rowDetail(row, false)).toEqual([{ text: '#8' }])
  })
})

describe('filterLinkedPrRows', () => {
  const rows = rowsFor([
    pr(612, { title: 'Retry with jitter', checks: rollupChecks([{ state: 'failure' }]) }),
    pr(611, { title: 'Draft the sync', draft: true }),
    pr(500, { title: 'Old cleanup', state: 'merged', sourceBranch: 'chore/cleanup' }),
  ])

  it.each([
    ['612', [612]],
    ['#611', [611]],
    ['jitter', [612]],
    ['chore/clean', [500]],
    ['merged', [500]],
    ['open', [612, 611]],
    ['draft', [611]],
    ['build failed', [612]],
    ['open jitter', [612]],
    ['  ', [612, 611, 500]],
    ['nothing here', []],
  ])('"%s" matches %j', (query, expected) => {
    expect(numbers(filterLinkedPrRows(rows, query))).toEqual(expected)
  })
})

describe('capLinkedPrRows', () => {
  const rows = rowsFor(Array.from({ length: 13 }, (_, i) => pr(i + 1)))

  it(`shows ${LINKED_PR_ROW_CAP} rows and hides the rest behind "Show N more"`, () => {
    const { shown, hidden } = capLinkedPrRows(rows, false)
    expect(shown).toHaveLength(10)
    expect(hidden).toBe(3)
  })

  it('shows every row once expanded, or when there are ten or fewer', () => {
    expect(capLinkedPrRows(rows, true)).toEqual({ shown: rows, hidden: 0 })
    expect(capLinkedPrRows(rows.slice(0, 10), false).hidden).toBe(0)
  })
})

describe('chip', () => {
  it('counts open and linked PRs', () => {
    expect(chipCounts(rowsFor([pr(1), pr(2, { draft: true }), pr(3, { state: 'merged' })]))).toEqual({
      open: 2,
      linked: 3,
    })
  })

  it('takes its icon from a failed open PR before the newest one', () => {
    const rows = rowsFor([pr(1, { checks: rollupChecks([{ state: 'failure' }]) }), pr(2)])
    expect(chipIconRow(rows).link.ref.number).toBe(1)
    expect(chipIconRow(rowsFor([pr(1), pr(2)])).link.ref.number).toBe(2)
  })
})
