/**
 * DriftWatcher integration: a REAL git repo with REAL `git worktree add`
 * worktrees (one nested .switchboard-style, one under /tmp - both layouts
 * users actually get), driven with the exact tool.started shapes each
 * provider adapter emits. This is the whole pipeline except the 5-line
 * registry glue: event in -> worktree.drift out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DriftWatcher, parseWorktreeList } from '../../src/main/provider/worktree-drift'
import { scrubGitEnv } from '../../src/main/git/checkpoint'

const execFileP = promisify(execFile)
// scrubGitEnv: the pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which
// would point this test's nested git at the OUTER repo.
const gitEnv = scrubGitEnv(process.env)

describe('DriftWatcher against a real repo', () => {
  let repo: string
  let nestedWt: string
  let tmpWt: string
  let watcher: DriftWatcher

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
    rmSync(tmpWt, { recursive: true, force: true }) // git worktree add wants it absent
    git(['worktree', 'add', '-q', '-b', 'fork/feat-x', nestedWt])
    git(['worktree', 'add', '-q', '-b', 'fork/tmp-y', tmpWt])
    watcher = new DriftWatcher(async (folder) => {
      const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: folder, env: gitEnv })
      return parseWorktreeList(stdout)
    })
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(tmpWt, { recursive: true, force: true })
  })

  it('claude shape: Write into the nested worktree fires drift once, then dedupes', async () => {
    const ev = await watcher.onToolStarted('t1', repo, 'Write', {
      file_path: join(nestedWt, 'src', 'new.ts'),
      content: 'x',
    })
    expect(ev).toEqual({
      type: 'worktree.drift',
      threadId: 't1',
      // Emitted paths are realpaths - /tmp and /var/folders are symlinks into
      // /private on macOS, and the swap pointer must be the canonical form.
      worktreePath: realpathSync(nestedWt),
      branch: 'fork/feat-x',
    })
    const again = await watcher.onToolStarted('t1', repo, 'Edit', { file_path: join(nestedWt, 'other.ts') })
    expect(again).toBeNull() // one banner per (thread, worktree)
  })

  it('codex shape: fileChange changes[] into a /tmp worktree fires drift', async () => {
    const ev = await watcher.onToolStarted('t2', repo, 'Edit', {
      changes: [{ path: join(tmpWt, 'b.ts'), kind: 'add' }],
    })
    expect(ev?.worktreePath).toBe(realpathSync(tmpWt))
    expect(ev?.branch).toBe('fork/tmp-y')
  })

  it('opencode/ACP shape: write rawInput path fires drift; reads never do', async () => {
    const ev = await watcher.onToolStarted('t3', repo, 'write', { path: join(nestedWt, 'c.txt'), content: '' })
    expect(ev?.branch).toBe('fork/feat-x')
    expect(await watcher.onToolStarted('t4', repo, 'read', { path: join(nestedWt, 'c.txt') })).toBeNull()
  })

  it('writes inside the session folder never fire, and separate threads get separate dedupe', async () => {
    expect(await watcher.onToolStarted('t5', repo, 'Write', { file_path: join(repo, 'ok.ts') })).toBeNull()
    // t1 already saw nestedWt, but t5 has not - each session gets its own prompt
    const ev = await watcher.onToolStarted('t5', repo, 'Write', { file_path: join(nestedWt, 'd.ts') })
    expect(ev?.threadId).toBe('t5')
  })

  it('Bash `git worktree add` flow: worktree created mid-turn is seen on command completion (fresh list, not the cache)', async () => {
    // Warm the cache with a state where the new worktree does not exist yet.
    await watcher.onToolStarted('t7', repo, 'Write', { file_path: join(repo, 'warm.ts') })
    const lateWt = mkdtempSync(join(tmpdir(), 'sb-drift-late-'))
    rmSync(lateWt, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'test/late', lateWt], { cwd: repo, env: gitEnv })
    try {
      const ev = await watcher.onCommandCompleted('t7', repo, 'Bash', {
        command: `git worktree add ${lateWt} -b test/late`,
      })
      expect(ev?.branch).toBe('test/late')
    } finally {
      rmSync(lateWt, { recursive: true, force: true })
    }
  })

  it('sessions rooted IN a worktree treat the main repo as foreign', async () => {
    const ev = await watcher.onToolStarted('t6', nestedWt, 'Write', { file_path: join(repo, 'main-side.ts') })
    expect(ev?.branch).toBe('main')
  })
})
