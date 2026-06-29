/**
 * Git checkpoint primitives for the in-chat diff-review feature.
 *
 * A "checkpoint" snapshots the full working tree (including untracked files)
 * into a git *tree object* via a throwaway temp index - without touching the
 * user's real index or HEAD. Diffing the start-checkpoint tree against an
 * end-checkpoint tree yields exactly the files changed during a turn,
 * regardless of which agent provider made the edits.
 *
 * We stub the GitRunner to assert the issued argv + env without shelling out.
 */
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCheckpoint,
  diffCheckpoint,
  isGitRepo,
  type CheckpointGitRunner,
} from '../../src/main/git/checkpoint'

const execFileP = promisify(execFile)

describe('createCheckpoint', () => {
  it('snapshots the working tree into a tree object via a temp index', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const runner: CheckpointGitRunner = async (args, _cwd, env) => {
      calls.push({ args, env })
      if (args[0] === 'add') return { stdout: '', stderr: '' }
      if (args[0] === 'write-tree') return { stdout: 'deadbeef\n', stderr: '' }
      throw new Error('unexpected ' + args.join(' '))
    }
    const res = await createCheckpoint('/repo', runner)
    expect(res).toEqual({ ok: true, tree: 'deadbeef' })

    const add = calls.find((c) => c.args[0] === 'add')!
    const writeTree = calls.find((c) => c.args[0] === 'write-tree')!
    // `add -A` stages every working-tree change (incl. untracked).
    expect(add.args).toContain('-A')
    // Both commands must share the SAME throwaway index, isolated from the
    // user's real index.
    expect(add.env?.GIT_INDEX_FILE).toBeTruthy()
    expect(writeTree.env?.GIT_INDEX_FILE).toBe(add.env?.GIT_INDEX_FILE)
  })

  it('returns an error result when git fails', async () => {
    const runner: CheckpointGitRunner = async () => {
      throw new Error('fatal: not a git repository')
    }
    const res = await createCheckpoint('/repo', runner)
    expect(res.ok).toBe(false)
  })
})

describe('diffCheckpoint', () => {
  it('returns per-file add / modify / delete with old + new content', async () => {
    const runner: CheckpointGitRunner = async (args) => {
      if (args[0] === 'add') return { stdout: '', stderr: '' }
      if (args[0] === 'write-tree') return { stdout: 'ENDTREE\n', stderr: '' }
      if (args[0] === 'diff') {
        // -z --name-status --no-renames <start> <end>
        return { stdout: 'M\0a.txt\0A\0c.txt\0D\0b.txt\0', stderr: '' }
      }
      if (args[0] === 'show') {
        const map: Record<string, string> = {
          'STARTTREE:a.txt': 'old-a\n',
          'ENDTREE:a.txt': 'new-a\n',
          'ENDTREE:c.txt': 'new-c\n',
          'STARTTREE:b.txt': 'old-b\n',
        }
        const spec = args[1]
        if (!(spec in map)) throw new Error('unexpected show ' + spec)
        return { stdout: map[spec], stderr: '' }
      }
      throw new Error('unexpected ' + args.join(' '))
    }
    const res = await diffCheckpoint('/repo', 'STARTTREE', runner)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files).toEqual([
      { relPath: 'a.txt', changeKind: 'modify', oldContent: 'old-a\n', newContent: 'new-a\n' },
      { relPath: 'c.txt', changeKind: 'add', oldContent: '', newContent: 'new-c\n' },
      { relPath: 'b.txt', changeKind: 'delete', oldContent: 'old-b\n', newContent: '' },
    ])
  })

  it('returns an empty file list when nothing changed', async () => {
    const runner: CheckpointGitRunner = async (args) => {
      if (args[0] === 'add') return { stdout: '', stderr: '' }
      if (args[0] === 'write-tree') return { stdout: 'ENDTREE\n', stderr: '' }
      if (args[0] === 'diff') return { stdout: '', stderr: '' }
      throw new Error('unexpected ' + args.join(' '))
    }
    const res = await diffCheckpoint('/repo', 'STARTTREE', runner)
    expect(res).toEqual({ ok: true, files: [] })
  })
})

describe('isGitRepo', () => {
  it('is true when inside a work tree', async () => {
    const runner: CheckpointGitRunner = async () => ({ stdout: 'true\n', stderr: '' })
    expect(await isGitRepo('/repo', runner)).toBe(true)
  })
  it('is false when git errors (not a repo)', async () => {
    const runner: CheckpointGitRunner = async () => {
      throw new Error('fatal: not a git repository')
    }
    expect(await isGitRepo('/repo', runner)).toBe(false)
  })
})

/**
 * End-to-end against real `git` - the stub can't catch a wrong flag (e.g.
 * `--name-status`). Verifies a checkpoint on a DIRTY tree isolates only the
 * turn's changes and captures untracked additions + deletions.
 */
describe('checkpoint against real git', () => {
  it('isolates turn changes on a dirty repo, including untracked + deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sb-ckpt-real-'))
    try {
      const git = (args: string[]) => execFileP('git', args, { cwd: dir })
      await git(['init', '-q'])
      await git(['config', 'user.email', 't@t.io'])
      await git(['config', 'user.name', 't'])
      await writeFile(join(dir, 'a.txt'), 'l1\nl2\n')
      await writeFile(join(dir, 'b.txt'), 'keep\n')
      await git(['add', '-A'])
      await git(['commit', '-qm', 'init'])

      // Pre-existing uncommitted change BEFORE the turn - must not leak in.
      await writeFile(join(dir, 'a.txt'), 'l1\nDIRTY\nl2\n')

      const start = await createCheckpoint(dir)
      expect(start.ok).toBe(true)
      if (!start.ok) return

      // Agent edits during the turn: modify a.txt, add untracked c.txt, delete b.txt.
      await writeFile(join(dir, 'a.txt'), 'l1\nDIRTY\nl2\nAGENT\n')
      await writeFile(join(dir, 'c.txt'), 'brand new\n')
      await unlink(join(dir, 'b.txt'))

      const diff = await diffCheckpoint(dir, start.tree)
      expect(diff.ok).toBe(true)
      if (!diff.ok) return

      const byPath = Object.fromEntries(diff.files.map((f) => [f.relPath, f]))
      expect(byPath['a.txt']).toMatchObject({
        changeKind: 'modify',
        oldContent: 'l1\nDIRTY\nl2\n', // baseline includes the pre-existing dirty line
        newContent: 'l1\nDIRTY\nl2\nAGENT\n',
      })
      expect(byPath['c.txt']).toMatchObject({ changeKind: 'add', oldContent: '', newContent: 'brand new\n' })
      expect(byPath['b.txt']).toMatchObject({ changeKind: 'delete', oldContent: 'keep\n', newContent: '' })

      // The user's real index/HEAD were never touched: a.txt still shows as
      // an unstaged modification.
      const status = await git(['status', '--porcelain'])
      expect(status.stdout).toContain('a.txt')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
