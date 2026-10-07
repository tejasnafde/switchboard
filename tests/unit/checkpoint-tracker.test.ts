/**
 * CheckpointTracker turns the git-checkpoint primitives into the provider-
 * agnostic turn lifecycle: snapshot at turn start, diff at turn end, and emit
 * one `file.edited` runtime event per changed file. Pure logic - git is faked.
 */
import { describe, it, expect } from 'vitest'
import { CheckpointTracker, type StoredTurnCheckpoint, type TurnCheckpointStore } from '../../src/main/provider/checkpoint-tracker'
import { pathKey } from '../../src/main/provider/agent-written-paths'
import type { CheckpointFileDiff } from '../../src/main/git/checkpoint'

function fakeDeps(over: {
  isGit?: boolean
  files?: CheckpointFileDiff[]
  createOk?: boolean
  /** Trees the start checkpoints return, in order (default START). */
  trees?: string[]
  /** Records which start tree each diff ran against. */
  diffedFrom?: string[]
  store?: TurnCheckpointStore
}) {
  let snapshots = 0
  return {
    isGitRepo: async () => over.isGit ?? true,
    createCheckpoint: async () =>
      over.createOk === false
        ? ({ ok: false as const, error: 'boom' })
        : ({ ok: true as const, tree: over.trees?.[snapshots++] ?? 'START' }),
    diffCheckpoint: async (_root: string, tree: string) => {
      over.diffedFrom?.push(tree)
      return { ok: true as const, files: over.files ?? [], endTree: `END-of-${tree}` }
    },
    store: over.store ?? null,
  }
}

function memoryStore(earlier: Record<string, StoredTurnCheckpoint> = {}) {
  const rows = new Map<string, StoredTurnCheckpoint>()
  const store: TurnCheckpointStore = {
    save: (threadId, cp) => { rows.set(threadId, cp) },
    remove: (threadId) => { rows.delete(threadId) },
    takeEarlier: (threadId) => {
      const cp = earlier[threadId] ?? null
      delete earlier[threadId]
      return cp
    },
  }
  return { store, rows }
}

/** Mark every path as written by the agent's own edit tool. */
function agentWrote(t: CheckpointTracker, threadId: string, ...paths: string[]) {
  paths.forEach((p, i) => {
    t.noteToolStarted(threadId, `tool-${p}-${i}`, 'Edit', { file_path: p })
    t.noteToolCompleted(threadId, `tool-${p}-${i}`)
  })
}

describe('CheckpointTracker', () => {
  it('emits one file.edited event per changed file with stable turn id', async () => {
    const files: CheckpointFileDiff[] = [
      { relPath: 'a.ts', changeKind: 'modify', oldContent: 'old\n', newContent: 'new\n' },
      { relPath: 'b.ts', changeKind: 'add', oldContent: '', newContent: 'added\n' },
    ]
    const t = new CheckpointTracker(fakeDeps({ files }))
    await t.beginTurn('thread-1', '/repo')
    agentWrote(t, 'thread-1', 'a.ts', '/repo/b.ts')
    const events = await t.finishTurn('thread-1')
    const turnId = events[0]?.turnId
    expect(turnId).toMatch(/^[0-9a-f]{8}-1$/)

    expect(events).toEqual([
      {
        type: 'file.edited',
        threadId: 'thread-1',
        turnId,
        fileEditId: `${turnId}:a.ts`,
        repoRoot: '/repo',
        relPath: 'a.ts',
        changeKind: 'modify',
        oldContent: 'old\n',
        newContent: 'new\n',
      },
      {
        type: 'file.edited',
        threadId: 'thread-1',
        turnId,
        fileEditId: `${turnId}:b.ts`,
        repoRoot: '/repo',
        relPath: 'b.ts',
        changeKind: 'add',
        oldContent: '',
        newContent: 'added\n',
      },
    ])
  })

  it('produces a unique turn id per turn even within the same millisecond (D11)', async () => {
    const files: CheckpointFileDiff[] = [
      { relPath: 'a.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
    ]
    // now() is pinned to a constant - two back-to-back turns would collide if
    // the turn id were derived from the clock.
    const t = new CheckpointTracker(fakeDeps({ files }))
    await t.beginTurn('thread-1', '/repo')
    const first = await t.finishTurn('thread-1')
    await t.beginTurn('thread-1', '/repo')
    const second = await t.finishTurn('thread-1')
    expect(first[0].fileEditId).not.toBe(second[0].fileEditId)
    // Stored cards are keyed by it, so a second launch must not reuse it.
    const relaunched = new CheckpointTracker(fakeDeps({ files }))
    await relaunched.beginTurn('thread-1', '/repo')
    expect((await relaunched.finishTurn('thread-1'))[0].fileEditId).not.toBe(first[0].fileEditId)
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

  it('offers no Reject for a file this chat did not write', async () => {
    const files: CheckpointFileDiff[] = [
      { relPath: 'mine.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
      { relPath: 'theirs.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
      { relPath: 'denied.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
      { relPath: 'logo.png', changeKind: 'modify', oldContent: '', newContent: '', noRevert: 'binary' },
    ]
    const t = new CheckpointTracker(fakeDeps({ files }))
    await t.beginTurn('t', '/repo')
    agentWrote(t, 't', 'mine.ts', 'logo.png')
    // Asked for, never completed (denied, or still running): not the agent's.
    t.noteToolStarted('t', 'denied', 'Write', { file_path: 'denied.ts' })
    // A Read names a path too, and writes nothing.
    t.noteToolStarted('t', 'read', 'Read', { file_path: 'theirs.ts' })
    t.noteToolCompleted('t', 'read')
    const events = await t.finishTurn('t')
    expect(events.map((e) => [e.relPath, e.noRevert])).toEqual([
      ['mine.ts', undefined],
      ['theirs.ts', 'outside'],
      ['denied.ts', 'outside'],
      ['logo.png', 'binary'],
    ])
  })

  it('counts the paths an adapter reports on completion (OpenCode)', async () => {
    const files: CheckpointFileDiff[] = [{ relPath: 'a.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' }]
    const t = new CheckpointTracker(fakeDeps({ files }))
    await t.beginTurn('t', '/repo')
    t.noteToolStarted('t', 'call-1', 'edit', {})
    t.noteToolCompleted('t', 'call-1', ['/repo/a.ts'])
    expect((await t.finishTurn('t'))[0].noRevert).toBeUndefined()
  })

  it('keeps the running turn baseline across a steer or a queued send', async () => {
    const diffedFrom: string[] = []
    const t = new CheckpointTracker(fakeDeps({ trees: ['FIRST', 'SECOND'], diffedFrom }))
    await t.beginTurn('t', '/repo')
    await t.beginTurn('t', '/repo', true)
    await t.finishTurn('t')
    expect(diffedFrom).toEqual(['FIRST'])
  })

  it('gives a queued turn the tree the previous turn ended on, whichever order the events come in', async () => {
    const diffedFrom: string[] = []
    const t = new CheckpointTracker(fakeDeps({ trees: ['FIRST'], diffedFrom }))
    await t.beginTurn('t', '/repo')
    // Claude reports the queued message started before the turn it waited on ends.
    t.startQueuedTurn('t')
    await t.finishTurn('t')
    await t.finishTurn('t')
    // After the end: the next queued message.
    t.startQueuedTurn('t')
    await t.finishTurn('t')
    expect(diffedFrom).toEqual(['FIRST', 'END-of-FIRST', 'END-of-END-of-FIRST'])
  })

  it('a turn that ended with nothing queued leaves no baseline behind', async () => {
    const diffedFrom: string[] = []
    const t = new CheckpointTracker(fakeDeps({ diffedFrom, files: [{ relPath: 'a', changeKind: 'modify', oldContent: 'o', newContent: 'n' }] }))
    await t.beginTurn('t', '/repo')
    await t.finishTurn('t')
    // A turn.completed with no turn of ours (a background notification).
    expect(await t.finishTurn('t')).toEqual([])
    expect(diffedFrom).toEqual(['START'])
  })

  it('stores the running baseline and the paths written, and forgets them at turn end', async () => {
    const { store, rows } = memoryStore()
    const t = new CheckpointTracker(fakeDeps({ store }))
    await t.beginTurn('t', '/repo')
    agentWrote(t, 't', 'a.ts')
    expect(rows.get('t')).toMatchObject({ tree: 'START', repoRoot: '/repo', written: [pathKey('/repo/a.ts')] })
    await t.finishTurn('t')
    expect(rows.has('t')).toBe(false)
  })

  it('after a restart mid-turn, restores the baseline and what the agent wrote', async () => {
    const files: CheckpointFileDiff[] = [
      { relPath: 'a.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
      { relPath: 'b.ts', changeKind: 'modify', oldContent: 'o', newContent: 'n' },
    ]
    const diffedFrom: string[] = []
    const { store } = memoryStore({ t: { turnId: 'old-7', tree: 'BEFORE', repoRoot: '/repo', written: ['/repo/a.ts'] } })
    const t = new CheckpointTracker(fakeDeps({ files, diffedFrom, store }))
    expect(t.restoreEarlier('t')).toBe(true)
    const events = await t.finishTurn('t')
    expect(diffedFrom).toEqual(['BEFORE'])
    expect(events.map((e) => [e.fileEditId, e.noRevert])).toEqual([['old-7:a.ts', undefined], ['old-7:b.ts', 'outside']])
    expect(t.restoreEarlier('t')).toBe(false)
  })
})

describe('pathKey', () => {
  it('compares Windows paths regardless of separators and drive-letter case', () => {
    expect(pathKey('C:\\repo\\src\\a.ts', 'win32')).toBe(pathKey('c:/repo/src/a.ts', 'win32'))
    expect(pathKey('/repo/src/../a.ts', 'darwin')).toBe('/repo/a.ts')
  })
})
