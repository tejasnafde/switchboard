/**
 * Open a project on another machine (`shared/project-clone.ts`). The source
 * backend answers which remote and branch to clone and which ignored files
 * may be copied, and reads them one at a time. The target backend clones in
 * the background (the desktop polls STATUS, so no invoke waits on a network
 * transfer) and writes the copied files into a clone it made itself.
 */
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { BackendHost } from '../backend/host'
import { ProjectCloneChannels } from '@shared/ipc-channels'
import {
  IGNORED_FILE_MAX_BYTES,
  IGNORED_FILE_MAX_COUNT,
  NO_REMOTE_MESSAGE,
  chooseCloneRemote,
  isSafeCloneUrl,
  isTextContent,
  isValidCloneFolderName,
  lastProgressLine,
  offerableIgnoredPath,
  type CloneRequest,
  type CloneSourceResult,
  type CloneStartResult,
  type CloneStatus,
  type IgnoredReadResult,
} from '@shared/project-clone'
import { isValidRefName } from '../git/refs'
import { addProject, getProjects, removeProject } from '../db/database'
import { forgetProjectFavicon } from '../projects/favicon-resolver'
import { childProcessEnv } from '../shell-env'
import { resolveWithinRepo } from './files'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:project-clone')
const execFileP = promisify(execFile)

/** Never wait on a password prompt: there is no terminal to type it in. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = childProcessEnv()
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function gitOptional(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await git(cwd, args)).trim() || null
  } catch (err) {
    // Exit 1 is an answer (an unset key, a path that is not ignored), not a failure.
    if ((err as { code?: unknown }).code !== 1) log.warn('git failed', { cwd, args, err: (err as Error).message })
    return null
  }
}

export async function readCloneSource(projectPath: string): Promise<CloneSourceResult> {
  try {
    const remotes = (await git(projectPath, ['remote'])).split('\n').filter(Boolean)
    // Null on a detached HEAD.
    const branch = await gitOptional(projectPath, ['symbolic-ref', '--short', '-q', 'HEAD'])
    const choice = chooseCloneRemote({
      branch,
      trackedRemote: branch ? await gitOptional(projectPath, ['config', '--get', `branch.${branch}.remote`]) : null,
      trackedMerge: branch ? await gitOptional(projectPath, ['config', '--get', `branch.${branch}.merge`]) : null,
      remotes,
    })
    if (!choice) return { ok: false, reason: 'no-remote', error: NO_REMOTE_MESSAGE }
    const url = (await git(projectPath, ['remote', 'get-url', choice.remote])).trim()

    const listed = (
      await git(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
    )
      .split('\0')
      .filter(Boolean)
    const ignored: Array<{ path: string; size: number }> = []
    for (const path of listed) {
      if (ignored.length >= IGNORED_FILE_MAX_COUNT || !offerableIgnoredPath(path)) continue
      const content = await checkIgnoredFile(projectPath, path).catch((err: Error) => {
        log.warn('skipping an unreadable ignored file', { path, err: err.message })
        return null
      })
      if (content !== null) ignored.push({ path, size: Buffer.byteLength(content, 'utf8') })
    }
    return {
      ok: true,
      remoteName: choice.remote,
      url,
      branch,
      remoteBranch: choice.remoteBranch,
      ignored,
      skippedIgnored: listed.length - ignored.length,
    }
  } catch (err) {
    log.warn('reading the clone source failed', { projectPath, err: (err as Error).message })
    return { ok: false, reason: 'error', error: (err as Error).message }
  }
}

/**
 * The file's text when it may be copied: inside the project, ignored by git,
 * not under an install or build folder, a regular file (not a link), at most
 * `IGNORED_FILE_MAX_BYTES`, and text. Null otherwise.
 */
async function checkIgnoredFile(projectPath: string, relPath: string): Promise<string | null> {
  if (!offerableIgnoredPath(relPath)) return null
  const abs = await resolveWithinRepo(projectPath, relPath)
  const stat = await fs.lstat(abs)
  if (!stat.isFile() || stat.size > IGNORED_FILE_MAX_BYTES) return null
  const bytes = await fs.readFile(abs)
  if (!isTextContent(bytes)) return null
  if ((await gitOptional(projectPath, ['check-ignore', '--', relPath])) === null) return null
  return bytes.toString('utf8')
}

export async function readIgnoredFile(projectPath: string, relPath: string): Promise<IgnoredReadResult> {
  try {
    const content = await checkIgnoredFile(projectPath, relPath)
    return content === null ? { ok: false, error: `${relPath} cannot be copied` } : { ok: true, content }
  } catch (err) {
    log.warn('reading an ignored file failed', { projectPath, relPath, err: (err as Error).message })
    return { ok: false, error: (err as Error).message }
  }
}

// ponytail: in memory, so a backend restart mid-clone answers 'unknown' and the half clone stays on disk.
const clones = new Map<string, CloneStatus>()

export function cloneStatus(path: string): CloneStatus {
  return clones.get(path) ?? { phase: 'unknown' }
}

export interface CloneDeps {
  projectsDir: string
  /** Resolves when the clone has ended, for tests. */
  onSettled?: (status: CloneStatus) => void
}

/**
 * Start a clone into `<projectsDir>/<name>` and list it as a project at once,
 * so a chat can be opened while it runs (the desktop holds the send until it
 * ends). A failed clone removes the folder and the project row.
 */
export async function startClone(request: CloneRequest, deps: CloneDeps): Promise<CloneStartResult> {
  const { url, remoteBranch, name } = request
  if (!isSafeCloneUrl(url)) return { ok: false, error: 'This remote URL cannot be cloned.' }
  if (!isValidCloneFolderName(name)) return { ok: false, error: `"${name}" is not a usable folder name.` }
  if (remoteBranch !== null && !isValidRefName(remoteBranch)) return { ok: false, error: 'Invalid branch name.' }
  const dest = join(deps.projectsDir, name)
  try {
    await fs.mkdir(deps.projectsDir, { recursive: true })
    // mkdir without recursive fails on an existing folder, which claims the name.
    await fs.mkdir(dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, error: `${dest} already exists on this machine. Add it as a project, or remove it first.` }
    }
    return { ok: false, error: (err as Error).message }
  }
  const listedBefore = getProjects().some((p) => p.path === dest)
  addProject(dest, name)
  clones.set(dest, { phase: 'cloning', line: 'Starting the clone' })
  log.info('clone started', { dest, remoteBranch })
  void runClone(url, remoteBranch, dest).then(async (status) => {
    if (status.phase === 'failed') {
      if (!listedBefore) removeProject(dest)
      await fs.rm(dest, { recursive: true, force: true }).catch((err) => log.warn('removing a failed clone', err))
    }
    forgetProjectFavicon(dest)
    clones.set(dest, status)
    log.info('clone ended', { dest, phase: status.phase })
    deps.onSettled?.(status)
  })
  return { ok: true, path: dest }
}

async function runClone(url: string, remoteBranch: string | null, dest: string): Promise<CloneStatus> {
  const first = await gitClone(url, remoteBranch, dest)
  // A branch the remote does not have (never pushed): clone the default branch instead.
  const result =
    first.ok || remoteBranch === null || !/Remote branch .* not found/i.test(first.stderr)
      ? first
      : await gitClone(url, null, dest)
  if (!result.ok) return { phase: 'failed', error: lastProgressLine(result.stderr) || 'git clone failed' }
  return { phase: 'done', branch: await gitOptional(dest, ['rev-parse', '--abbrev-ref', 'HEAD']) }
}

function gitClone(url: string, remoteBranch: string | null, dest: string): Promise<{ ok: boolean; stderr: string }> {
  const args = ['-c', 'protocol.ext.allow=never', 'clone', '--progress']
  if (remoteBranch) args.push('--branch', remoteBranch)
  args.push('--', url, dest)
  return new Promise((resolve) => {
    const child = spawn('git', args, { env: gitEnv(), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep the tail only: progress rewrites one line thousands of times.
      stderr = (stderr + chunk.toString('utf8')).slice(-8192)
      const line = lastProgressLine(stderr)
      if (line) clones.set(dest, { phase: 'cloning', line })
    })
    child.on('error', (err) => resolve({ ok: false, stderr: err.message }))
    child.on('close', (code) => resolve({ ok: code === 0, stderr }))
  })
}

/**
 * Write one copied ignored file into a finished clone this backend made. It
 * must be ignored here too (so a tracked file is never replaced) and must
 * not exist yet.
 */
export async function writeIgnoredFile(
  projectPath: string,
  relPath: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (clones.get(projectPath)?.phase !== 'done') return { ok: false, error: 'Not a finished clone on this machine.' }
    if (!offerableIgnoredPath(relPath) || Buffer.byteLength(content, 'utf8') > IGNORED_FILE_MAX_BYTES) {
      return { ok: false, error: `${relPath} cannot be copied` }
    }
    const abs = await resolveWithinRepo(projectPath, relPath)
    if ((await gitOptional(projectPath, ['check-ignore', '--', relPath])) === null) {
      return { ok: false, error: `${relPath} is not ignored by git here, so it was not written.` }
    }
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, { flag: 'wx', mode: 0o600 })
    return { ok: true }
  } catch (err) {
    log.warn('writing a copied ignored file failed', { projectPath, relPath, err: (err as Error).message })
    return { ok: false, error: (err as Error).message }
  }
}

export function registerProjectCloneHandlers(host: BackendHost): void {
  host.handle(ProjectCloneChannels.SOURCE, (projectPath: string) => readCloneSource(projectPath))
  host.handle(ProjectCloneChannels.READ_IGNORED, (projectPath: string, relPath: string) =>
    readIgnoredFile(projectPath, relPath),
  )
  host.handle(ProjectCloneChannels.CLONE, (request: CloneRequest) =>
    // ponytail: one fixed projects folder; add a setting when someone keeps projects elsewhere.
    startClone(request, { projectsDir: join(homedir(), 'projects') }),
  )
  host.handle(ProjectCloneChannels.STATUS, (path: string) => cloneStatus(path))
  host.handle(ProjectCloneChannels.WRITE_IGNORED, (projectPath: string, relPath: string, content: string) =>
    writeIgnoredFile(projectPath, relPath, content),
  )
}
