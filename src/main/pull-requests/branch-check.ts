/**
 * What `create_pull_request` asks git in the chat's checkout before it shows
 * a card: the current branch, and whether a branch is on the remote of the
 * pull request's repository (`git ls-remote`, which fetches no objects).
 * Never prompts: a remote that wants a password answers as unreachable.
 */
import { execFile } from 'node:child_process'
import { isBranchName } from '@shared/agent-pr-create'
import type { RepoRef } from '@shared/pull-requests'
import { remotesForRepo } from '@shared/pull-request-remote'
import { createMainLogger } from '../logger'
import { childProcessEnv } from '../shell-env'

const log = createMainLogger('pull-requests:branch-check')

const GIT_TIMEOUT_MS = 20_000

export type GitRun = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const defaultGitRun: GitRun = (cwd, args) =>
  new Promise((resolve) => {
    const env = { ...childProcessEnv(), GIT_TERMINAL_PROMPT: '0' }
    execFile('git', ['-C', cwd, ...args], { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: err?.killed ? `${String(stderr)}\ngit did not answer within ${GIT_TIMEOUT_MS / 1000}s` : String(stderr) })
    })
  })

/** The checked-out branch, or null (detached HEAD, not a repository). */
export async function currentBranch(cwd: string, run: GitRun = defaultGitRun): Promise<string | null> {
  const res = await run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = res.stdout.trim()
  if (res.code !== 0 || !isBranchName(branch)) {
    log.debug('no current branch', { cwd, code: res.code })
    return null
  }
  return branch
}

export type RemoteBranch =
  | { ok: true; found: boolean; remote: string }
  | { ok: false; message: string }

/** Whether `branch` is on the remote this checkout has for `repo`. */
export async function remoteHasBranch(cwd: string, repo: RepoRef, branch: string, run: GitRun = defaultGitRun): Promise<RemoteBranch> {
  const remotes = await run(cwd, ['remote', '-v'])
  const remote = remotesForRepo(remotes.code === 0 ? remotes.stdout : '', repo).find((name) => !name.startsWith('-'))
  if (!remote) return { ok: false, message: `This checkout has no git remote for ${repo.owner}/${repo.name}.` }
  const ref = `refs/heads/${branch}`
  const res = await run(cwd, ['ls-remote', '--heads', remote, ref])
  if (res.code !== 0) {
    // The first line names the cause (Permission denied, a host it could not resolve); later ones are git's summary.
    const said = (res.stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/\.+$/, '')
    log.warn('git ls-remote failed', { remote, code: res.code })
    return { ok: false, message: `git could not read the branches of ${remote}${said ? `: ${said.slice(0, 200)}` : ''}.` }
  }
  const found = res.stdout.split('\n').some((line) => line.split('\t')[1]?.trim() === ref)
  return { ok: true, found, remote }
}
