/**
 * Which bare `bbpr <n>` numbers are PRs of the chat's own repository. bbpr
 * reads the repository from the git remote of the directory it runs in, so a
 * number counts only when that directory is the chat's repository: the tool's
 * own cwd (no `cd`), or a `cd` target whose remotes point at it. A `cd` that
 * cannot be resolved is skipped, never guessed. Shared by the live auto-link
 * and the history scan.
 */
import type { BbprTarget } from '@shared/bbpr-command'
import { repoKey, type RepoRef } from '@shared/pull-requests'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:bbpr-targets')

export async function bbprNumbersInRepo(
  targets: readonly BbprTarget[],
  chatRepo: RepoRef | null,
  /** A directory's repository, from its git remotes. */
  repoForDir: (dir: string) => Promise<RepoRef | null>,
): Promise<number[]> {
  if (chatRepo?.host !== 'bitbucket') return []
  const key = repoKey(chatRepo)
  const dirs = new Map<string, Promise<boolean>>()
  const inRepo = (dir: string): Promise<boolean> => {
    let hit = dirs.get(dir)
    if (!hit) {
      hit = repoForDir(dir).then((repo) => repo !== null && repoKey(repo) === key, (err) => {
        log.warn('reading the repository of a bbpr directory failed', { dir, err: String(err) })
        return false
      })
      dirs.set(dir, hit)
    }
    return hit
  }
  const numbers: number[] = []
  for (const target of targets) {
    if (numbers.includes(target.number)) continue
    if (target.runsIn === 'cwd' || (target.runsIn === 'dir' && await inRepo(target.dir))) numbers.push(target.number)
  }
  return numbers
}
