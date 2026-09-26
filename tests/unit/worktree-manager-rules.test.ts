import { describe, expect, it } from 'vitest'
import {
  applyProtectionPatch,
  classifyWorktree,
  filterCounts,
  formatBytes,
  gitStateLabel,
  ignoredLosses,
  ignoredSummary,
  isRegenerableIgnored,
  REGENERABLE_IGNORED_DIRS,
  matchesFilter,
  parseRemovalAck,
  parseProtectionPatch,
  parseWorktreeProtection,
  protectionSource,
  removalConfirmBody,
  removalVerdict,
  type WorktreeRow,
} from '../../src/shared/worktree-manager'

function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    projectPath: '/repo',
    projectName: 'repo',
    path: '/repo/.switchboard/worktrees/a',
    branch: 'kanban/a',
    head: 'abcdef1234',
    prunable: false,
    locked: false,
    owned: false,
    chat: null,
    protectedBy: null,
    git: { uncommittedFiles: 0, ignoredFiles: 0, ignoredSample: [], unpushedCommits: 0, merged: true },
    ...overrides,
  }
}

const dirty = (files: number, commits = 0) => ({ uncommittedFiles: files, ignoredFiles: 0, ignoredSample: [] as string[], unpushedCommits: commits, merged: false })
const ignoring = (...names: string[]) => ({ uncommittedFiles: 0, ignoredFiles: names.length, ignoredSample: names.slice(0, 3), unpushedCommits: 0, merged: true })

describe('classifyWorktree', () => {
  it('calls a clean worktree with nothing unpushed safe, merged or not', () => {
    expect(classifyWorktree(row())).toBe('safe')
    expect(classifyWorktree(row({ git: { uncommittedFiles: 0, ignoredFiles: 0, ignoredSample: [], unpushedCommits: 0, merged: false } }))).toBe('safe')
  })

  it('puts uncommitted files, unpushed commits and unreadable git state under Has changes', () => {
    expect(classifyWorktree(row({ git: dirty(3) }))).toBe('has_changes')
    expect(classifyWorktree(row({ git: dirty(0, 2) }))).toBe('has_changes')
    expect(classifyWorktree(row({ git: null }))).toBe('has_changes')
  })

  it('ranks in use above protection, and protection above git state', () => {
    expect(classifyWorktree(row({ owned: true, protectedBy: 'project', git: dirty(1) }))).toBe('in_use')
    expect(classifyWorktree(row({ protectedBy: 'project', git: dirty(1) }))).toBe('protected')
    expect(classifyWorktree(row({ protectedBy: 'worktree' }))).toBe('protected')
    expect(classifyWorktree(row({ locked: true }))).toBe('protected')
  })
})

describe('filters', () => {
  it('hides protected rows from every tab, All included', () => {
    const p = row({ protectedBy: 'project' })
    for (const f of ['all', 'safe', 'has_changes', 'in_use'] as const) expect(matchesFilter(p, f)).toBe(false)
  })

  it('counts each tab', () => {
    const rows = [row(), row({ git: dirty(1) }), row({ owned: true }), row({ owned: true }), row({ protectedBy: 'worktree' })]
    expect(filterCounts(rows)).toEqual({ all: 4, safe: 1, has_changes: 1, in_use: 2 })
  })
})

describe('removalVerdict', () => {
  it('removes a safe worktree without force and deletes its branch', () => {
    expect(removalVerdict(row(), null)).toEqual({ ok: true, force: false, deleteBranch: 'kanban/a' })
  })

  it('never removes an owned, protected, locked or unreadable worktree, whatever was acknowledged', () => {
    const ack = { uncommittedFiles: 99, unpushedCommits: 99, ignoredFiles: 99 }
    for (const r of [row({ owned: true }), row({ protectedBy: 'project' }), row({ protectedBy: 'worktree' }), row({ locked: true }), row({ git: null })]) {
      expect(removalVerdict(r, ack).ok).toBe(false)
    }
  })

  it('needs an acknowledgement before losing anything', () => {
    const verdict = removalVerdict(row({ git: dirty(3) }), null)
    expect(verdict).toMatchObject({ ok: false })
    expect(!verdict.ok && verdict.reason).toMatch(/3 uncommitted files/)
  })

  it('refuses when the worktree gained changes after the confirm', () => {
    const verdict = removalVerdict(row({ git: dirty(5) }), { uncommittedFiles: 1, unpushedCommits: 0, ignoredFiles: 0 })
    expect(!verdict.ok && verdict.reason).toMatch(/changed since you confirmed/)
    expect(removalVerdict(row({ git: dirty(0, 2) }), { uncommittedFiles: 0, unpushedCommits: 1, ignoredFiles: 0 }).ok).toBe(false)
  })

  it('forces only for uncommitted files, and keeps a branch that holds unpushed commits', () => {
    expect(removalVerdict(row({ git: dirty(2) }), { uncommittedFiles: 2, unpushedCommits: 0, ignoredFiles: 0 }))
      .toEqual({ ok: true, force: true, deleteBranch: 'kanban/a' })
    expect(removalVerdict(row({ git: dirty(0, 1) }), { uncommittedFiles: 0, unpushedCommits: 1, ignoredFiles: 0 }))
      .toEqual({ ok: true, force: false, deleteBranch: null })
  })
})

describe('protection', () => {
  it('parses what it writes, and treats junk as nothing protected', () => {
    const p = applyProtectionPatch({ projects: [], worktrees: [] }, { target: 'project', path: '/repo', protected: true })
    expect(parseWorktreeProtection(JSON.stringify(p))).toEqual({ projects: ['/repo'], worktrees: [] })
    expect(parseWorktreeProtection('{nope')).toEqual({ projects: [], worktrees: [] })
    expect(parseWorktreeProtection(JSON.stringify({ projects: ['/a', 3, '/a', ''] }))).toEqual({ projects: ['/a'], worktrees: [] })
    expect(parseWorktreeProtection(null)).toEqual({ projects: [], worktrees: [] })
  })

  it('adds once and removes cleanly', () => {
    let p = { projects: [], worktrees: [] as string[] }
    p = applyProtectionPatch(p, { target: 'worktree', path: '/w', protected: true })
    p = applyProtectionPatch(p, { target: 'worktree', path: '/w', protected: true })
    expect(p.worktrees).toEqual(['/w'])
    expect(applyProtectionPatch(p, { target: 'worktree', path: '/w', protected: false }).worktrees).toEqual([])
  })

  it('accepts only a well-formed protection patch from IPC', () => {
    expect(parseProtectionPatch({ target: 'project', path: '/repo', protected: true }))
      .toEqual({ target: 'project', path: '/repo', protected: true })
    expect(parseProtectionPatch({ target: 'worktree', path: 'C:\\repo\\wt', protected: false })?.target).toBe('worktree')
    for (const bad of [
      null, 'x', {},
      { target: 'repo', path: '/repo', protected: true },
      { target: 'project', path: 'relative/repo', protected: true },
      { target: 'project', path: 42, protected: true },
      { target: 'project', path: '/repo', protected: 0 },
      { target: 'project', path: '/repo' },
    ]) expect(parseProtectionPatch(bad)).toBeNull()
  })

  it('reports the project before the worktree', () => {
    const p = { projects: ['/repo'], worktrees: ['/repo/w'] }
    expect(protectionSource(p, '/repo', '/repo/w')).toBe('project')
    expect(protectionSource({ projects: [], worktrees: ['/repo/w'] }, '/repo', '/repo/w')).toBe('worktree')
    expect(protectionSource(p, '/other', '/other/w')).toBeNull()
  })
})

describe('labels', () => {
  it('keeps normal states plain and marks only the exceptions', () => {
    expect(gitStateLabel(row())).toEqual({ text: 'Merged, clean', tone: 'muted' })
    expect(gitStateLabel(row({ git: { uncommittedFiles: 0, ignoredFiles: 0, ignoredSample: [], unpushedCommits: 0, merged: false } })).text).toBe('Pushed, clean')
    expect(gitStateLabel(row({ git: dirty(3) }))).toEqual({ text: '3 uncommitted files', tone: 'warn' })
    expect(gitStateLabel(row({ git: dirty(1, 1) })).text).toBe('1 uncommitted file, 1 unpushed commit')
    expect(gitStateLabel(row({ owned: true, chat: { kind: 'chat', id: 'c', title: 'T', archived: false } })))
      .toMatchObject({ text: 'In use', tone: 'lock', title: expect.stringMatching(/live chat/) })
  })

  it('names every loss in the confirm, and says a branch with unpushed commits stays', () => {
    const body = removalConfirmBody(row({ git: dirty(3, 2) }))
    expect(body).toMatch(/3 uncommitted files will be deleted/)
    expect(body).toMatch(/2 unpushed commits .* stay on branch kanban\/a/)
    expect(removalConfirmBody(row({ git: dirty(0, 1) }))).toBe('1 unpushed commit exists nowhere else. It stays on branch kanban/a, which is not deleted.')
    expect(removalConfirmBody(row({ branch: null, git: dirty(0, 1) }))).toMatch(/detached HEAD, will be lost/)
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
    expect(formatBytes(1.45 * 1024 ** 3)).toBe('1.4 GB')
  })
})

describe('ignored files', () => {
  it('treats regenerable build output as no loss, top-level or node_modules anywhere', () => {
    for (const dir of ['node_modules', 'dist', 'out', 'build', '.next', 'coverage', '.turbo']) {
      expect(REGENERABLE_IGNORED_DIRS).toContain(dir)
      expect(isRegenerableIgnored(`${dir}/`)).toBe(true)
    }
    expect(isRegenerableIgnored('packages/app/node_modules/')).toBe(true)
    expect(isRegenerableIgnored('dist\\bundle.js')).toBe(true)
    expect(isRegenerableIgnored('.env')).toBe(false)
    expect(isRegenerableIgnored('src/dist/')).toBe(false)
    expect(isRegenerableIgnored('secrets/')).toBe(false)
  })

  it('keeps local work, and drops folders listed only because they hold other listed entries', () => {
    expect(ignoredLosses(['.env', 'a.log', 'dist/', 'node_modules/', 'pkg/', 'pkg/node_modules/', 'secrets/', '']))
      .toEqual(['.env', 'a.log', 'secrets/'])
    expect(ignoredLosses(['q/', 'q/x.log'])).toEqual(['q/x.log'])
  })

  it('makes a row Has changes and names the files', () => {
    const r = row({ git: ignoring('.env', 'local.json', 'secrets/') })
    expect(classifyWorktree(r)).toBe('has_changes')
    expect(ignoredSummary(r.git!)).toBe('.env and 2 other ignored files')
    expect(ignoredSummary(ignoring('.env'))).toBe('ignored .env')
    expect(gitStateLabel(r)).toEqual({ text: '.env and 2 other ignored files', tone: 'warn' })
    expect(removalConfirmBody(r)).toBe('.env and 2 other ignored files will be deleted and cannot be recovered.')
    expect(removalConfirmBody(row({ git: { ...ignoring('.env'), uncommittedFiles: 2 } })))
      .toBe('2 uncommitted files and ignored .env will be deleted and cannot be recovered.')
  })

  it('needs the ignored files acknowledged like uncommitted ones, without forcing', () => {
    const r = row({ git: ignoring('.env', 'local.json') })
    expect(removalVerdict(r, null).ok).toBe(false)
    // An acknowledgement without the ignored count is malformed, not zero.
    expect(removalVerdict(r, { uncommittedFiles: 0, unpushedCommits: 0 })).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid removal confirmation/i) })
    expect(removalVerdict(r, { uncommittedFiles: 0, unpushedCommits: 0, ignoredFiles: 1 }).ok).toBe(false)
    expect(removalVerdict(r, { uncommittedFiles: 0, unpushedCommits: 0, ignoredFiles: 2 }))
      .toEqual({ ok: true, force: false, deleteBranch: 'kanban/a' })
  })
})

describe('parseRemovalAck', () => {
  const valid = { uncommittedFiles: 2, unpushedCommits: 0, ignoredFiles: 1 }

  it('takes no acknowledgement as nothing acknowledged, and a well-formed one as is', () => {
    expect(parseRemovalAck(null)).toEqual({ ok: true, ack: null })
    expect(parseRemovalAck(undefined)).toEqual({ ok: true, ack: null })
    expect(parseRemovalAck(valid)).toEqual({ ok: true, ack: valid })
  })

  it('refuses missing, NaN, negative, fractional, string and extra-field counts', () => {
    const bad: unknown[] = [
      {},
      { uncommittedFiles: 2, unpushedCommits: 0 },
      { ...valid, uncommittedFiles: Number.NaN },
      { ...valid, unpushedCommits: -1 },
      { ...valid, ignoredFiles: 1.5 },
      { ...valid, uncommittedFiles: Number.POSITIVE_INFINITY },
      { ...valid, uncommittedFiles: '2' },
      { ...valid, force: true },
      [2, 0, 1],
      'yes',
      true,
    ]
    for (const value of bad) {
      expect(parseRemovalAck(value)).toMatchObject({ ok: false, error: expect.stringMatching(/invalid removal confirmation/i) })
    }
  })

  it('makes removalVerdict refuse a truthy malformed acknowledgement instead of letting it pass the loss check', () => {
    // `undefined < 3` is false, so `{}` used to cover any loss.
    const verdict = removalVerdict(row({ git: dirty(3) }), {})
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid removal confirmation/i) })
    expect(removalVerdict(row(), { ...valid, extra: 1 }).ok).toBe(false)
  })
})
