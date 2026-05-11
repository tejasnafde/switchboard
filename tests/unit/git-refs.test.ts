/**
 * Pure parsers + invocation tests for the per-thread branch picker.
 *
 *   - parseForEachRef: turn `git for-each-ref` output into Ref[] with
 *     local/remote classification + worktreePath joined in
 *   - parseWorktreeBranchMap: porcelain output -> Map<branchName,path>
 *     (used to annotate each ref with whether it already has a worktree
 *     so the picker can reuse vs. checkout)
 *   - isValidRefName: defense-in-depth for `git checkout <ref>` — reject
 *     anything that starts with `-`, contains `..`, control chars, or
 *     spaces. Matches a subset of git's own check-ref-format rules.
 *   - listRefs / switchRef / getCurrentBranch: stubbed-runner integration
 *     tests that verify the right git argv goes out and the result is
 *     wired through correctly.
 */
import { describe, expect, it } from 'vitest'
import {
  parseForEachRef,
  parseWorktreeBranchMap,
  isValidRefName,
  listRefs,
  switchRef,
  getCurrentBranch,
  type GitRunner,
} from '../../src/main/git/refs'

describe('parseWorktreeBranchMap', () => {
  it('returns empty map on empty input', () => {
    expect(parseWorktreeBranchMap('').size).toBe(0)
  })

  it('maps each branch to its worktree path, skipping detached entries', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.switchboard/worktrees/foo',
      'HEAD bbbb',
      'branch refs/heads/feat/foo',
      '',
      'worktree /repo/.switchboard/worktrees/det',
      'HEAD cccc',
      'detached',
      '',
    ].join('\n')
    const map = parseWorktreeBranchMap(porcelain)
    expect(map.get('main')).toBe('/repo')
    expect(map.get('feat/foo')).toBe('/repo/.switchboard/worktrees/foo')
    expect(map.size).toBe(2)
  })
})

describe('parseForEachRef', () => {
  // Format we ask git for: '%(refname)\t%(objectname)\t%(HEAD)'
  // Three fields, tab-delimited, one ref per line.
  // (NUL was the original delimiter but Node.js execFile rejects null bytes in argv.)
  const sample = [
    'refs/heads/main\tabc123\t*',
    'refs/heads/feat/foo\tdef456\t ',
    'refs/remotes/origin/main\tabc123\t ',
    'refs/remotes/origin/feature\tghi789\t ',
  ].join('\n')

  it('classifies local vs. remote and surfaces the current branch', () => {
    const refs = parseForEachRef(sample, new Map())
    expect(refs).toHaveLength(4)
    const main = refs.find((r) => r.name === 'main')!
    expect(main.isRemote).toBe(false)
    expect(main.current).toBe(true)
    expect(main.sha).toBe('abc123')
    const featFoo = refs.find((r) => r.name === 'feat/foo')!
    expect(featFoo.current).toBe(false)
    expect(featFoo.isRemote).toBe(false)
    const originMain = refs.find((r) => r.name === 'origin/main')!
    expect(originMain.isRemote).toBe(true)
  })

  it('joins worktree paths from the porcelain map onto matching local refs', () => {
    const map = new Map([['feat/foo', '/repo/.switchboard/worktrees/foo']])
    const refs = parseForEachRef(sample, map)
    const featFoo = refs.find((r) => r.name === 'feat/foo')!
    expect(featFoo.worktreePath).toBe('/repo/.switchboard/worktrees/foo')
    const main = refs.find((r) => r.name === 'main')!
    expect(main.worktreePath).toBeNull()
  })

  it('ignores blank lines and malformed records', () => {
    const noisy = '\n\nrefs/heads/main\tabc\t*\n\nbroken-line-no-tab\n'
    const refs = parseForEachRef(noisy, new Map())
    expect(refs).toHaveLength(1)
    expect(refs[0].name).toBe('main')
  })
})

describe('isValidRefName', () => {
  it('accepts ordinary branch names', () => {
    expect(isValidRefName('main')).toBe(true)
    expect(isValidRefName('feat/foo-bar_2')).toBe(true)
    expect(isValidRefName('release/2024-01-01')).toBe(true)
  })

  it('rejects names starting with - (would be parsed as a flag)', () => {
    expect(isValidRefName('-rf')).toBe(false)
    expect(isValidRefName('--no-edit')).toBe(false)
  })

  it('rejects path traversal sequences', () => {
    expect(isValidRefName('foo/../bar')).toBe(false)
    expect(isValidRefName('..')).toBe(false)
  })

  it('rejects whitespace and control chars', () => {
    expect(isValidRefName('foo bar')).toBe(false)
    expect(isValidRefName('foo\tbar')).toBe(false)
    expect(isValidRefName('foo\nbar')).toBe(false)
  })

  it('rejects empty and overlong names', () => {
    expect(isValidRefName('')).toBe(false)
    expect(isValidRefName('a'.repeat(300))).toBe(false)
  })

  it('rejects names ending in / or .lock (git rules)', () => {
    expect(isValidRefName('foo/')).toBe(false)
    expect(isValidRefName('foo.lock')).toBe(false)
  })
})

describe('listRefs (stubbed runner)', () => {
  it('issues the right git argv and returns parsed refs annotated with worktree paths', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'worktree') {
        return {
          stdout: 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n',
          stderr: '',
        }
      }
      // for-each-ref
      return {
        stdout: 'refs/heads/main\tabc\t*\nrefs/heads/dev\tdef\t \n',
        stderr: '',
      }
    }
    const refs = await listRefs('/repo', runner)
    expect(calls.map((c) => c.args[0])).toEqual(['worktree', 'for-each-ref'])
    expect(refs).toHaveLength(2)
    expect(refs.find((r) => r.name === 'main')!.current).toBe(true)
  })
})

describe('switchRef (stubbed runner)', () => {
  it('runs `git checkout <ref>` for a valid local ref', async () => {
    const calls: string[][] = []
    const runner: GitRunner = async (args) => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    }
    await switchRef('/repo', 'feat/foo', runner)
    expect(calls).toEqual([['checkout', 'feat/foo']])
  })

  it('throws on an invalid ref name (does NOT shell out)', async () => {
    const runner: GitRunner = async () => {
      throw new Error('runner should not be called')
    }
    await expect(switchRef('/repo', '-rf', runner)).rejects.toThrow(/invalid ref/i)
    await expect(switchRef('/repo', 'foo/../bar', runner)).rejects.toThrow(/invalid ref/i)
  })
})

describe('getCurrentBranch (stubbed runner)', () => {
  it('returns the trimmed branch name', async () => {
    const runner: GitRunner = async (args) => {
      expect(args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD'])
      return { stdout: 'main\n', stderr: '' }
    }
    expect(await getCurrentBranch('/repo', runner)).toBe('main')
  })

  it('returns null on detached HEAD (git outputs "HEAD")', async () => {
    const runner: GitRunner = async () => ({ stdout: 'HEAD\n', stderr: '' })
    expect(await getCurrentBranch('/repo', runner)).toBeNull()
  })
})
