/**
 * `git rerere` ("reuse recorded resolution") setup helpers for the
 * Branches screen.
 *
 * When enabled, git memoizes manual conflict resolutions and replays
 * them automatically the next time it sees the same conflict diff.
 * That's invaluable when re-merging a branch after iterating on it.
 *
 * One-shot: enable it on first Branches-screen open per repo, then
 * leave it on. Affects every conflict resolution in the repo (not just
 * Branches-driven ones), which is almost always desirable.
 */

import type { GitRunner } from '../worktree'

/** Set `rerere.enabled = true` in the repo's local git config. */
export async function enableRerere(repoPath: string, runner: GitRunner): Promise<void> {
  await runner(['config', 'rerere.enabled', 'true'], repoPath)
}

/** Probe whether rerere is on. `git config --get` exits 1 when the key
 *  isn't set; we treat that as "not enabled." */
export async function isRerereEnabled(repoPath: string, runner: GitRunner): Promise<boolean> {
  try {
    const { stdout } = await runner(['config', '--get', 'rerere.enabled'], repoPath)
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}
