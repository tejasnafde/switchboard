/**
 * CheckpointTracker turns the git-checkpoint primitives into the provider-
 * agnostic turn lifecycle: snapshot at turn start, diff at turn end, and emit
 * one `file.edited` runtime event per changed file. Pure logic — git is faked.
 */
import { describe, it, expect } from 'vitest'
import { CheckpointTracker } from '../../src/main/provider/checkpoint-tracker'
import type { CheckpointFileDiff } from '../../src/main/git/checkpoint'

function fakeDeps(over: {
  isGit?: boolean
  files?: CheckpointFileDiff[]
  createOk?: boolean
  now?: number
}) {
  return {
    isGitRepo: async () => over.isGit ?? true,
    createCheckpoint: async () =>
      over.createOk === false
        ? ({ ok: false as const, error: 'boom' })
        : ({ ok: true as const, tree: 'START' }),
    diffCheckpoint: async () => ({ ok: true as const, files: over.files ?? [] }),
    now: () => over.now ?? 1000,
  }
}

describe('CheckpointTracker', () => {
  it('emits one file.edited event per changed file with stable turn id', async () => {
    const files: CheckpointFileDiff[] = [
      { relPath: 'a.ts', changeKind: 'modify', oldContent: 'old\n', newContent: 'new\n' },
      { relPath: 'b.ts', changeKind: 'add', oldContent: '', newContent: 'added\n' },
    ]
    const t = new CheckpointTracker(fakeDeps({ files, now: 42 }))
    await t.beginTurn('thread-1', '/repo')
    const events = await t.finishTurn('thread-1')

    expect(events).toEqual([
      {
        type: 'file.edited',
        threadId: 'thread-1',
        turnId: '42',
        fileEditId: '42:a.ts',
        repoRoot: '/repo',
        relPath: 'a.ts',
        changeKind: 'modify',
        oldContent: 'old\n',
        newContent: 'new\n',
      },
      {
        type: 'file.edited',
        threadId: 'thread-1',
        turnId: '42',
        fileEditId: '42:b.ts',
        repoRoot: '/repo',
        relPath: 'b.ts',
        changeKind: 'add',
        oldContent: '',
        newContent: 'added\n',
      },
    ])
  })

  it('returns no events when finishTurn is called without a prior beginTurn', async () => {
    const t = new CheckpointTracker(fakeDeps({}))
    expect(await t.finishTurn('thread-x')).toEqual([])
  })

  it('skips checkpointing entirely for a non-git directory', async () => {
    const t = new CheckpointTracker(fakeDeps({ isGit: false, files: [{ relPath: 'a', changeKind: 'add', oldContent: '', newContent: 'x' }] }))
    await t.beginTurn('thread-2', '/not-a-repo')
    expect(await t.finishTurn('thread-2')).toEqual([])
  })

  it('returns no events when the start checkpoint failed to create', async () => {
    const t = new CheckpointTracker(fakeDeps({ createOk: false }))
    await t.beginTurn('thread-3', '/repo')
    expect(await t.finishTurn('thread-3')).toEqual([])
  })

  it('consumes the pending checkpoint so a second finishTurn is empty', async () => {
    const files: CheckpointFileDiff[] = [{ relPath: 'a', changeKind: 'modify', oldContent: 'o', newContent: 'n' }]
    const t = new CheckpointTracker(fakeDeps({ files }))
    await t.beginTurn('thread-4', '/repo')
    expect(await t.finishTurn('thread-4')).toHaveLength(1)
    expect(await t.finishTurn('thread-4')).toEqual([])
  })
})
