/**
 * DriftWatcher integration: a REAL git repo with REAL `git worktree add`
 * worktrees (one nested .switchboard-style, one under /tmp - both layouts
 * users actually get), driven with the exact tool.started shapes each
 * provider adapter emits. Command checks are deferred to the thread's next
 * event because the Claude adapter never emits tool.completed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Drift events carry posix-normalized paths (Windows fs APIs emit backslashes,
// git porcelain emits forward slashes - the watcher unifies them).
const posix = (p: string): string => p.replace(/\\/g, '/')
import { DriftWatcher, parseWorktreeList } from '../../src/main/provider/worktree-drift'
import { realpathOrAncestor } from '../../src/main/ipc/files'
import { scrubGitEnv } from '../../src/main/git/checkpoint'

const execFileP = promisify(execFile)
// scrubGitEnv: the pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which
// would point this test's nested git at the OUTER repo.
const gitEnv = scrubGitEnv(process.env)

describe('DriftWatcher against a real repo', () => {
  let repo: string
  let nestedWt: string
  let tmpWt: string
  let listCalls: Array<boolean | undefined>
  let watcher: DriftWatcher

  const makeWatcher = () =>
    new DriftWatcher(async (folder, fresh) => {
      listCalls.push(fresh)
      const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: folder, env: gitEnv })
      // Normalization happens at the registry cache boundary in production.
      return Promise.all(parseWorktreeList(stdout).map(async (wt) => ({ ...wt, path: await realpathOrAncestor(wt.path) })))
    }, realpathOrAncestor)

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'sb-drift-repo-'))
    const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: gitEnv })
    git(['init', '-q'])
    git(['config', 'user.email', 't@t.io'])
    git(['config', 'user.name', 't'])
    writeFileSync(join(repo, 'a.txt'), 'x')
    git(['add', '-A'])
    git(['commit', '-qm', 'init'])
    nestedWt = join(repo, '.switchboard', 'worktrees', 'feat-x')
    tmpWt = mkdtempSync(join(tmpdir(), 'sb-drift-wt-'))
    rmSync(tmpWt, { recursive: true, force: true })
    git(['worktree', 'add', '-q', '-b', 'fork/feat-x', nestedWt])
    git(['worktree', 'add', '-q', '-b', 'fork/tmp-y', tmpWt])
    listCalls = []
    watcher = makeWatcher()
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(tmpWt, { recursive: true, force: true })
  })

  it('claude shape: Write into the nested worktree fires drift once, then dedupes within the turn', async () => {
    const ev = await watcher.onToolStarted('t1', repo, 'Write', {
      file_path: join(nestedWt, 'src', 'new.ts'),
      content: 'x',
    })
    expect(ev).toEqual({
      type: 'worktree.drift',
      threadId: 't1',
      worktreePath: posix(realpathSync(nestedWt)),
      branch: 'fork/feat-x',
    })
    expect(await watcher.onToolStarted('t1', repo, 'Edit', { file_path: join(nestedWt, 'other.ts') })).toBeNull()
  })

  it('per-turn re-arm: the same drift re-suggests after the turn ends (dismissal is per-turn, not forever)', async () => {
    expect(await watcher.onTurnCompleted('t1', repo)).toBeNull()
    const again = await watcher.onToolStarted('t1', repo, 'Write', { file_path: join(nestedWt, 'more.ts') })
    expect(again?.branch).toBe('fork/feat-x')
    await watcher.onTurnCompleted('t1', repo)
  })

  it('codex shape: fileChange changes[] into a /tmp worktree fires drift', async () => {
    const ev = await watcher.onToolStarted('t2', repo, 'Edit', {
      changes: [{ path: join(tmpWt, 'b.ts'), kind: 'add' }],
    })
    expect(ev?.worktreePath).toBe(posix(realpathSync(tmpWt)))
    expect(ev?.branch).toBe('fork/tmp-y')
  })

  it('opencode/ACP shapes: free-form title writes fire; reads never do', async () => {
    const ev = await watcher.onToolStarted('t3', repo, 'Write c.txt', { path: join(nestedWt, 'c.txt') })
    expect(ev?.branch).toBe('fork/feat-x')
    expect(await watcher.onToolStarted('t4', repo, 'Read c.txt', { path: join(nestedWt, 'c.txt') })).toBeNull()
  })

  it('command flow WITHOUT tool.completed (claude): stash on Bash start, flush on the next event', async () => {
    const lateWt = mkdtempSync(join(tmpdir(), 'sb-drift-late-'))
    rmSync(lateWt, { recursive: true, force: true })
    // Bash tool starts: worktree does not exist yet - nothing can fire.
    const atStart = await watcher.onToolStarted('t8', repo, 'Bash', {
      command: `git worktree add "${lateWt}" -b test/late`,
    })
    expect(atStart).toBeNull()
    // The command runs (worktree appears), then the NEXT tool starts.
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'test/late', lateWt], { cwd: repo, env: gitEnv })
    try {
      const flushed = await watcher.onToolStarted('t8', repo, 'Read', { path: join(repo, 'a.txt') })
      expect(flushed?.branch).toBe('test/late')
      // The flush for a worktree-mutating command bypassed the cache.
      expect(listCalls.at(-1)).toBe(true)
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', lateWt], { cwd: repo, env: gitEnv })
      rmSync(lateWt, { recursive: true, force: true })
    }
  })

  it('command flow flushes at turn end when the command was the last tool of the turn', async () => {
    const lateWt2 = mkdtempSync(join(tmpdir(), 'sb-drift-late2-'))
    rmSync(lateWt2, { recursive: true, force: true })
    expect(
      await watcher.onToolStarted('t9', repo, 'Bash', { command: `git worktree add "${lateWt2}" -b test/late2` })
    ).toBeNull()
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'test/late2', lateWt2], { cwd: repo, env: gitEnv })
    try {
      const flushed = await watcher.onTurnCompleted('t9', repo)
      expect(flushed?.branch).toBe('test/late2')
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', lateWt2], { cwd: repo, env: gitEnv })
      rmSync(lateWt2, { recursive: true, force: true })
    }
  })

  it('writes inside the session folder never fire, and separate threads get separate dedupe', async () => {
    expect(await watcher.onToolStarted('t5', repo, 'Write', { file_path: join(repo, 'ok.ts') })).toBeNull()
    const ev = await watcher.onToolStarted('t5', repo, 'Write', { file_path: join(nestedWt, 'd.ts') })
    expect(ev?.threadId).toBe('t5')
  })

  it('sessions rooted IN a worktree treat the main repo as foreign', async () => {
    const ev = await watcher.onToolStarted('t6', nestedWt, 'Write', { file_path: join(repo, 'main-side.ts') })
    expect(ev?.worktreePath).toBe(posix(realpathSync(repo)))
  })

  it('onSessionMoved re-baselines: after following into the worktree, main becomes the foreign side', async () => {
    await watcher.onToolStarted('t10', repo, 'Write', { file_path: join(nestedWt, 'x.ts') })
    watcher.onSessionMoved('t10')
    const ev = await watcher.onToolStarted('t10', nestedWt, 'Write', { file_path: join(repo, 'reverse.ts') })
    expect(ev?.worktreePath).toBe(posix(realpathSync(repo)))
  })

  it('stopped sessions drop all state', async () => {
    await watcher.onToolStarted('t11', repo, 'Bash', { command: `ls ${tmpWt}` })
    watcher.onSessionStopped('t11')
    // The stash was cleared - the next event has nothing to flush.
    expect(await watcher.onTurnCompleted('t11', repo)).toBeNull()
  })
})
