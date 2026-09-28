/**
 * Reviews empty and error states (one line and one fix each), the list's
 * notices, short times, the Files tree, and the unified diff parser.
 */
import { describe, expect, it } from 'vitest'
import {
  agoPhrase,
  conflictPhrase,
  declineConfirmCopy,
  describePrError,
  describeRepoFailures,
  groupFilesByDir,
  hiddenReposLabel,
  hideReposConfirmCopy,
  restorableHiddenRepos,
  mergeConfirmCopy,
  rerunUnavailable,
  reviewListState,
  rowSubtitle,
  shortAgo,
  writeErrorText,
} from '../../src/renderer/components/reviews/review-states'
import { parseHunks, splitGitDiff, unquoteGitPath } from '../../src/shared/unified-diff'
import type { PrError, PrErrorKind, PrListData, PrSummary, RepoRef } from '../../src/shared/pull-requests'

const gh: RepoRef = { host: 'github', owner: 'o', name: 'switchboard' }
const bb: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'bot' }
const err = (kind: PrErrorKind, host: PrError['host'] = 'bitbucket', message = 'x'): PrError => ({ kind, host, message })
const data = (over: Partial<PrListData>): PrListData => ({ prs: [], sources: [], unsupportedProjects: [], fetchedAt: 0, hidden: [], ...over })

describe('describePrError', () => {
  it('gives every error kind one line and one fix', () => {
    const kinds: PrErrorKind[] = [
      'no_account', 'unsupported_repo', 'token_rejected', 'rate_limited', 'offline', 'needs_desktop', 'gh_missing', 'not_found',
      'forbidden', 'conflict', 'stale', 'invalid', 'unknown',
    ]
    for (const kind of kinds) {
      const n = describePrError(err(kind))
      expect(n.line.length).toBeGreaterThan(0)
      expect(n.fix.length).toBeGreaterThan(0)
      expect(n.line).not.toContain('\n')
    }
  })

  it('sends account problems to Settings and transient ones to Retry', () => {
    expect(describePrError(err('no_account')).action).toBe('settings')
    expect(describePrError(err('token_rejected', 'bitbucket')).action).toBe('settings')
    expect(describePrError(err('token_rejected', 'github')).fix).toContain('gh auth login')
    expect(describePrError(err('offline', 'github')).line).toBe('Could not reach github.com.')
    expect(describePrError(err('rate_limited', 'github')).action).toBe('retry')
    expect(describePrError(err('needs_desktop')).action).toBeNull()
  })
})

describe('write copy', () => {
  it('shows the host reason for a refused write and the fix for account or network trouble', () => {
    expect(writeErrorText(err('stale', 'github', 'New commits were pushed since you looked.'))).toBe('New commits were pushed since you looked.')
    expect(writeErrorText(err('forbidden', 'bitbucket', 'You cannot approve your own pull request'))).toBe('You cannot approve your own pull request')
    expect(writeErrorText(err('offline', 'github'))).toBe('Could not reach github.com. Check the connection, then retry.')
  })

  it('names the target branch and the strategy in the merge confirm', () => {
    const copy = mergeConfirmCopy({ ref: { ...gh, number: 159 }, title: 'Retry settings.json', sourceBranch: 'fix/win', targetBranch: 'main' }, 'merge_commit')
    expect(copy.title).toBe('Merge #159 into main?')
    expect(copy.body).toContain('merges fix/win into main on GitHub. Strategy: merge commit.')
    expect(copy.confirmLabel).toBe('Merge')
  })

  it('names the PR and that it changes it for everyone in the decline confirm, with the host verb', () => {
    const bbCopy = declineConfirmCopy({ ref: { ...bb, number: 612 }, title: 'Jittered backoff' })
    expect(bbCopy).toMatchObject({ title: 'Decline #612?', confirmLabel: 'Decline', destructive: true })
    expect(bbCopy.body).toContain('"Jittered backoff" is declined on Bitbucket for everyone')
    const ghCopy = declineConfirmCopy({ ref: { ...gh, number: 161 }, title: 'Cost cap' })
    expect([ghCopy.title, ghCopy.confirmLabel]).toEqual(['Close #161?', 'Close'])
    expect(ghCopy.body).toContain('is closed on GitHub for everyone')
  })

  it('counts the conflicted files when the host names them', () => {
    expect(conflictPhrase({ targetBranch: 'main', conflictedFiles: ['a.py', 'b.py'] })).toBe('Conflicts with main in 2 files')
    expect(conflictPhrase({ targetBranch: 'main', conflictedFiles: ['a.py'] })).toBe('Conflicts with main in 1 file')
    expect(conflictPhrase({ targetBranch: 'develop', conflictedFiles: [] })).toBe('Conflicts with develop')
  })

  it('says why a failed check has no Re-run', () => {
    expect(rerunUnavailable({ ref: { ...gh, number: 1 } }, { rerunId: '42' })).toBeNull()
    expect(rerunUnavailable({ ref: { ...gh, number: 1 } }, { rerunId: null })).toContain('Only GitHub Actions runs')
    expect(rerunUnavailable({ ref: { ...bb, number: 1 } }, { rerunId: '42' })).toContain("Bitbucket's API cannot re-run")
  })
})

describe('reviewListState', () => {
  it('is loading before the first answer and blocked by a top-level error', () => {
    expect(reviewListState(null, null)).toEqual({ kind: 'loading' })
    expect(reviewListState(null, err('offline')).kind).toBe('blocked')
  })

  it('says when no project has a supported remote', () => {
    const state = reviewListState(data({ unsupportedProjects: ['/p/a'] }), null)
    expect(state).toMatchObject({ kind: 'blocked', notice: { id: 'unsupported' } })
    expect(reviewListState(data({}), null)).toMatchObject({ kind: 'blocked', notice: { id: 'no-projects' } })
  })

  it('blocks on one shared failure, and shows notices beside the rows otherwise', () => {
    expect(reviewListState(data({ sources: [{ repo: bb, projectPaths: [], error: err('no_account') }] }), null))
      .toMatchObject({ kind: 'blocked', notice: { id: 'bitbucket:no_account' } })
    const mixed = reviewListState(data({
      sources: [
        { repo: gh, projectPaths: [], error: null },
        { repo: bb, projectPaths: [], error: err('no_account') },
        { repo: { ...bb, name: 'other' }, projectPaths: [], error: err('no_account') },
      ],
    }), null)
    expect(mixed).toMatchObject({ kind: 'ready', notices: [{ id: 'bitbucket:no_account' }] })
  })

  it('names the repositories an account cannot see in one card per host and reason, with a hide action', () => {
    const staging = (name: string): RepoRef => ({ host: 'bitbucket', owner: 'geoiq-staging', name })
    const state = reviewListState(data({
      sources: [
        { repo: bb, projectPaths: [], error: null },
        { repo: staging('geoiq_broker_app_stg'), projectPaths: [], error: err('not_found') },
        { repo: staging('geoiqcore_stg'), projectPaths: [], error: err('not_found') },
        { repo: staging('geoiq_retailiq_admin_fe_in_stg'), projectPaths: [], error: err('not_found') },
        { repo: { ...bb, name: 'slow' }, projectPaths: [], error: err('rate_limited') },
      ],
    }), null)
    if (state.kind !== 'ready') throw new Error('expected ready')
    expect(state.notices.map((n) => n.id)).toEqual(['bitbucket:rate_limited', 'bitbucket:not_found'])
    const card = state.notices[1]
    expect(card.line).toBe('Cannot see 3 repositories in geoiq-staging: geoiq_broker_app_stg, geoiqcore_stg, geoiq_retailiq_admin_fe_in_stg.')
    expect(card.fix).toBe("The API token's account needs access to that workspace, or hide these repositories.")
    expect(card).toMatchObject({ action: 'hide-repos', actionLabel: 'Hide these repositories' })
    expect(card.repos?.map((r) => r.name)).toEqual(['geoiq_broker_app_stg', 'geoiqcore_stg', 'geoiq_retailiq_admin_fe_in_stg'])
    // The rate limit is not offered for hiding.
    expect(state.notices[0].action).toBe('retry')
  })

  it('blocks on the named card when every repository failed that way', () => {
    const state = reviewListState(data({ sources: [{ repo: bb, projectPaths: [], error: err('not_found') }] }), null)
    expect(state).toMatchObject({ kind: 'blocked', notice: { id: 'bitbucket:not_found', line: 'Cannot see 1 repository in geoiq: bot.', actionLabel: 'Hide this repository' } })
  })

  it('shows an empty list, not "No projects yet", when every repository is hidden', () => {
    expect(reviewListState(data({ hiddenRepos: [bb] }), null)).toEqual({ kind: 'ready', notices: [] })
  })
})

describe('restorableHiddenRepos', () => {
  const hidden: RepoRef[] = [{ host: 'github', owner: 'o', name: 'hidden' }]

  it('offers hidden repositories beside the rows', () => {
    const list = data({ sources: [{ repo: gh, projectPaths: [], error: null }], hiddenRepos: hidden })
    expect(restorableHiddenRepos(reviewListState(list, null), list)).toEqual(hidden)
  })

  it('still offers them when the rest are blocked by one notice (no account, or a repository it cannot see)', () => {
    for (const kind of ['no_account', 'not_found'] as const) {
      const list = data({ sources: [{ repo: bb, projectPaths: [], error: err(kind) }], hiddenRepos: hidden })
      const state = reviewListState(list, null)
      expect(state.kind).toBe('blocked')
      expect(restorableHiddenRepos(state, list)).toEqual(hidden)
    }
  })

  it('still offers them when the list read failed, from the list shown before', () => {
    const list = data({ sources: [{ repo: gh, projectPaths: [], error: null }], hiddenRepos: hidden })
    const state = reviewListState(list, err('offline', 'github'))
    expect(state.kind).toBe('blocked')
    expect(restorableHiddenRepos(state, list)).toEqual(hidden)
  })

  it('offers nothing while loading, from an older backend, or with nothing hidden', () => {
    expect(restorableHiddenRepos(reviewListState(null, null), null)).toEqual([])
    expect(restorableHiddenRepos(reviewListState(null, err('offline')), null)).toEqual([])
    const old = data({ sources: [{ repo: gh, projectPaths: [], error: null }] })
    expect(restorableHiddenRepos(reviewListState(old, null), old)).toEqual([])
  })

  it('leaves the hidden PR line to the ready state: a list blocked by its sources has no PRs', () => {
    const state = reviewListState(data({ sources: [{ repo: bb, projectPaths: [], error: err('no_account') }] }), null)
    expect(state.kind).toBe('blocked')
    // Any PR in the list makes it ready, so a hidden PR is never stuck behind a blocking notice.
    const withPr = data({ sources: [{ repo: bb, projectPaths: [], error: err('no_account') }], prs: [{ ref: { ...bb, number: 1 } } as PrSummary] })
    expect(reviewListState(withPr, null).kind).toBe('ready')
  })
})

describe('repository failure copy', () => {
  it('names every owner, caps long lists, and says what to do on GitHub', () => {
    const names = Array.from({ length: 8 }, (_, i) => `r${i}`)
    const notice = describeRepoFailures({
      host: 'github',
      kind: 'not_found',
      owners: [{ owner: 'acme', names }, { owner: 'side', names: ['one'] }],
      repos: [...names.map((name) => ({ host: 'github' as const, owner: 'acme', name })), { host: 'github', owner: 'side', name: 'one' }],
    })
    expect(notice.line).toBe('Cannot see 8 repositories in acme: r0, r1, r2, r3, r4, r5 and 2 more; 1 in side: one.')
    expect(notice.fix).toBe('The gh account needs access to those owners, or hide these repositories.')
  })

  it('says a refused organisation needs authorizing', () => {
    const notice = describeRepoFailures({ host: 'github', kind: 'forbidden', owners: [{ owner: 'acme', names: ['app'] }], repos: [{ host: 'github', owner: 'acme', name: 'app' }] })
    expect(notice.line).toBe('Not allowed to read 1 repository in acme: app.')
    expect(notice.fix).toContain('authorize it, or hide this repository')
  })

  it('names the repositories in the confirm and counts them in the hidden line', () => {
    const copy = hideReposConfirmCopy([bb, { ...bb, name: 'core' }])
    expect(copy.title).toBe('Hide 2 repositories from Reviews?')
    expect(copy.body).toContain('geoiq/bot, geoiq/core')
    expect(copy.body).toContain('Nothing changes on Bitbucket')
    expect(hideReposConfirmCopy([bb]).title).toBe('Hide this repository from Reviews?')
    expect(hiddenReposLabel(1)).toBe('1 repository hidden')
    expect(hiddenReposLabel(3)).toBe('3 repositories hidden')
  })
})

describe('times and subtitles', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  it('formats short and long relative times', () => {
    expect(shortAgo(NOW - 40 * 60_000, NOW)).toBe('40 m')
    expect(shortAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 h')
    expect(shortAgo(NOW - 3 * 86_400_000, NOW)).toBe('3 d')
    expect(agoPhrase(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago')
    expect(agoPhrase(NOW - 86_400_000, NOW)).toBe('yesterday')
    expect(agoPhrase(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago')
  })

  it('writes the row subtitle as repo, number, and one phrase', () => {
    const pr = { ref: { ...bb, number: 612 }, state: 'open', mergedAt: null } as PrSummary
    expect(rowSubtitle(pr, 'build failed', NOW)).toBe('bot · #612 · build failed')
    expect(rowSubtitle(pr, '', NOW)).toBe('bot · #612')
    expect(rowSubtitle({ ...pr, state: 'merged', mergedAt: NOW - 2 * 86_400_000 }, '', NOW)).toBe('bot · #612 · 2 days ago')
  })
})

describe('groupFilesByDir', () => {
  it('groups by directory in first-seen order with root files last', () => {
    const groups = groupFilesByDir([{ path: 'README.md' }, { path: 'sync/worker.py' }, { path: 'tests/t.py' }, { path: 'sync/backoff.py' }])
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.path)])).toEqual([
      ['sync/', ['sync/worker.py', 'sync/backoff.py']],
      ['tests/', ['tests/t.py']],
      ['./', ['README.md']],
    ])
  })
})

describe('unified diff', () => {
  it('stops at the line cap and says so', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', '@@ -10,1 +10,1 @@', ' z'].join('\n')
    expect(parseHunks(patch, 2)).toMatchObject({ truncated: true, hunks: [{ lines: [{ text: 'a' }, { text: 'b' }] }] })
    expect(parseHunks(patch).truncated).toBe(false)
  })

  it('parses a CRLF patch like an LF one', () => {
    const patch = ['@@ -1,2 +1,2 @@ fn()', ' a', '-b', '+c'].join('\r\n')
    const parsed = parseHunks(patch)
    expect(parsed).toEqual(parseHunks(patch.replace(/\r\n/g, '\n')))
    expect(parsed.hunks[0].header).toBe('@@ -1,2 +1,2 @@ fn()')
    expect(parsed.hunks[0].lines.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('decodes git C-quoted paths (octal UTF-8 bytes, escapes) in the header and the ---/+++ lines', () => {
    const q = '"a/dir/na\\303\\257ve.py"'
    const diff = [
      `diff --git ${q} "b/dir/na\\303\\257ve.py"`,
      `--- ${q}`,
      '+++ "b/dir/na\\303\\257ve.py"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git "a/tab\\there \\"q\\".md" b/plain.md',
      'similarity index 100%',
    ].join('\n')
    const files = splitGitDiff(diff)
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([
      ['dir/naïve.py', 'dir/naïve.py'],
      ['tab\there "q".md', 'plain.md'],
    ])
    expect(files[0].patch.startsWith('@@ -1 +1 @@')).toBe(true)
  })

  it('leaves an unquoted path alone, backslashes included', () => {
    expect(unquoteGitPath('dir\\file.txt')).toBe('dir\\file.txt')
    expect(unquoteGitPath('"\\342\\234\\223 done"')).toBe('✓ done')
    // core.quotePath=false: the emoji stays literal and only the tab is escaped.
    expect(unquoteGitPath('"a/\u{1F680}\\tfile"')).toBe('a/\u{1F680}\tfile')
  })

  it('reads quoted paths with spaces and a pure rename', () => {
    const files = splitGitDiff('diff --git "a/x y.md" "b/z w.md"\nsimilarity index 100%\nrename from x y.md\nrename to z w.md\n')
    expect(files).toEqual([{ oldPath: 'x y.md', newPath: 'z w.md', binary: false, patch: '' }])
  })
})
