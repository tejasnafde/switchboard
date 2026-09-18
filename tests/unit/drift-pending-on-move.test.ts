/**
 * Command evidence stashed BEFORE a relocation must not be judged against the
 * root the relocation moved to.
 *
 * `onToolStarted` defers a command tool: nothing has been written yet, so the
 * paths are checked on the next event. If a Follow lands in that gap, the
 * flush compares the old command's paths against the NEW home and reports
 * drift back to where the user just came from - the follow-back loop this
 * whole feature exists to kill.
 */
import { describe, it, expect } from 'vitest'
import { DriftWatcher, type WorktreeRef } from '../../src/main/provider/worktree-drift'

const WORKTREES: WorktreeRef[] = [
  { path: '/repo', branch: 'main' },
  { path: '/repo/.switchboard/worktrees/feat', branch: 'sb/feat' },
]

function watcher() {
  return new DriftWatcher(async () => WORKTREES, async (p) => p)
}

describe('DriftWatcher.onSessionMoved', () => {
  it('drops command evidence gathered before the move', async () => {
    const w = watcher()
    // Ran in /repo, touching /repo. Not drift at the time: it is home.
    await w.onToolStarted('t1', '/repo', 'Bash', { command: 'cd /repo/src && npm test' })
    // The user follows into the worktree.
    w.onSessionMoved('t1')
    // Flushing that old evidence now judges a /repo path against a worktree
    // home, so it reports drift straight back to /repo - the follow-back
    // loop this feature exists to kill.
    const event = await w.onTurnCompleted('t1', '/repo/.switchboard/worktrees/feat')
    expect(event).toBeNull()
  })

  it('still detects genuine drift after the move', async () => {
    const w = watcher()
    w.onSessionMoved('t1')
    const event = await w.onToolStarted('t1', '/repo/.switchboard/worktrees/feat', 'Write', {
      file_path: '/repo/src/a.ts',
    })
    expect(event).toMatchObject({ worktreePath: '/repo', branch: 'main' })
  })

  it('leaves another thread\'s pending evidence alone', async () => {
    const w = watcher()
    await w.onToolStarted('t2', '/repo', 'Bash', {
      command: 'cd /repo/.switchboard/worktrees/feat',
    })
    w.onSessionMoved('t1')
    const event = await w.onTurnCompleted('t2', '/repo')
    expect(event).toMatchObject({ worktreePath: '/repo/.switchboard/worktrees/feat' })
  })
})
