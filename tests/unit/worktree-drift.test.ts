/**
 * Worktree drift detection: when a session's agent starts WRITING into a git
 * worktree other than the session's folder, surface it so the user can follow
 * (one pointer drives the chip, IDE pane, terminals, and diff review).
 *
 * Detection is provider-agnostic because it feeds on the normalized
 * tool.started events every adapter already emits - the per-provider part is
 * only the input shape, pinned here with each adapter's REAL wire shapes:
 *   claude:   Write/Edit/MultiEdit {file_path}, NotebookEdit {notebook_path}
 *   codex:    fileChange items normalize to toolName 'Edit' with {changes:[{path}]}
 *   opencode: ACP tool_call, toolName = title||kind ('edit'/'write'), rawInput {path}
 */
import { describe, it, expect } from 'vitest'
import { extractWritePaths, extractCommandPaths, detectDrift } from '../../src/main/provider/worktree-drift'

describe('extractWritePaths', () => {
  it('claude: Write/Edit/MultiEdit file_path and NotebookEdit notebook_path', () => {
    expect(extractWritePaths('Write', { file_path: '/wt/a.ts', content: 'x' })).toEqual(['/wt/a.ts'])
    expect(extractWritePaths('Edit', { file_path: '/wt/b.ts', old_string: 'a', new_string: 'b' })).toEqual(['/wt/b.ts'])
    expect(extractWritePaths('MultiEdit', { file_path: '/wt/c.ts', edits: [] })).toEqual(['/wt/c.ts'])
    expect(extractWritePaths('NotebookEdit', { notebook_path: '/wt/n.ipynb' })).toEqual(['/wt/n.ipynb'])
  })

  it('codex: fileChange (normalized to Edit) carries changes[].path', () => {
    expect(
      extractWritePaths('Edit', { changes: [{ path: '/wt/x.ts', kind: 'update' }, { path: '/wt/y.ts', kind: 'add' }] })
    ).toEqual(['/wt/x.ts', '/wt/y.ts'])
  })

  it('opencode/ACP: edit and write kinds with rawInput path (or filePath)', () => {
    expect(extractWritePaths('edit', { path: '/x.txt' })).toEqual(['/x.txt'])
    expect(extractWritePaths('write', { filePath: '/wt/z.ts', content: '' })).toEqual(['/wt/z.ts'])
  })

  it('ignores read-only and unrelated tools even when they carry paths', () => {
    expect(extractWritePaths('Read', { file_path: '/wt/a.ts' })).toEqual([])
    expect(extractWritePaths('Bash', { command: 'echo hi', cwd: '/wt' })).toEqual([])
    expect(extractWritePaths('Grep', { path: '/wt' })).toEqual([])
    expect(extractWritePaths('read', { path: '/x.txt' })).toEqual([])
  })

  it('tolerates malformed input without throwing', () => {
    expect(extractWritePaths('Write', null)).toEqual([])
    expect(extractWritePaths('Edit', 'nope')).toEqual([])
    expect(extractWritePaths('Edit', { changes: 'nope' })).toEqual([])
    expect(extractWritePaths('Edit', { changes: [{ nopath: 1 }] })).toEqual([])
  })
})

describe('extractCommandPaths', () => {
  it('claude Bash: absolute path tokens in the command string', () => {
    expect(extractCommandPaths('Bash', { command: 'git worktree add /tmp/sb-x -b test/x' })).toEqual(['/tmp/sb-x'])
    expect(extractCommandPaths('Bash', { command: 'cd /repo/.switchboard/worktrees/feat-x && npm test' })).toEqual([
      '/repo/.switchboard/worktrees/feat-x',
    ])
    expect(extractCommandPaths('Bash', { command: "echo 'hi' > /tmp/wt/notes.md" })).toEqual(['/tmp/wt/notes.md'])
  })

  it('codex commandExecution (normalized to Bash): cwd counts as a path signal', () => {
    expect(extractCommandPaths('Bash', { command: 'npm test', cwd: '/tmp/wt' })).toEqual(['/tmp/wt'])
  })

  it('opencode ACP execute kind', () => {
    expect(extractCommandPaths('execute', { command: 'git -C /tmp/wt status' })).toEqual(['/tmp/wt'])
  })

  it('non-command tools and commands without absolute paths yield nothing', () => {
    expect(extractCommandPaths('Write', { command: '/tmp/x' })).toEqual([])
    expect(extractCommandPaths('Bash', { command: 'ls -la && git status' })).toEqual([])
    expect(extractCommandPaths('Bash', null)).toEqual([])
  })
})

describe('detectDrift', () => {
  const worktrees = [
    { path: '/repo', branch: 'main' },
    { path: '/repo/.switchboard/worktrees/feat-x', branch: 'fork/feat-x' },
    { path: '/repo/.switchboard/worktrees/feat-y', branch: 'kanban/feat-y' },
  ]

  it('returns the foreign worktree when a write lands inside it', () => {
    expect(detectDrift('/repo', ['/repo/.switchboard/worktrees/feat-x/src/a.ts'], worktrees)).toEqual({
      path: '/repo/.switchboard/worktrees/feat-x',
      branch: 'fork/feat-x',
    })
  })

  it('returns null for writes inside the session folder - including nested worktree dirs when the SESSION is the worktree', () => {
    expect(detectDrift('/repo', ['/repo/src/a.ts'], worktrees)).toBeNull()
    expect(
      detectDrift('/repo/.switchboard/worktrees/feat-x', ['/repo/.switchboard/worktrees/feat-x/src/a.ts'], worktrees)
    ).toBeNull()
  })

  it('longest-match wins: the main repo root must not swallow nested worktree paths', () => {
    // /repo is a prefix of the nested worktree path; the nested root must win.
    expect(detectDrift('/repo', ['/repo/.switchboard/worktrees/feat-y/b.ts'], worktrees)?.branch).toBe('kanban/feat-y')
  })

  it('returns null for paths outside every worktree and for prefix-collision folders', () => {
    expect(detectDrift('/repo', ['/tmp/scratch.ts'], worktrees)).toBeNull()
    // '/repo2/...' must not match the '/repo' root by string prefix
    expect(detectDrift('/repo', ['/repo2/a.ts'], worktrees)).toBeNull()
  })

  it('first drifting write wins across a batch', () => {
    const paths = ['/repo/src/ok.ts', '/repo/.switchboard/worktrees/feat-x/a.ts', '/repo/.switchboard/worktrees/feat-y/b.ts']
    expect(detectDrift('/repo', paths, worktrees)?.branch).toBe('fork/feat-x')
  })
})
