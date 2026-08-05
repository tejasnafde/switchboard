/**
 * Keeps the freshest transcript copy at the one path the SDK resumes from:
 * `<CLAUDE_CONFIG_DIR>/projects/<encode(cwd)>/<sessionId>.jsonl`. Both halves
 * move under a live chat - profile switch, or cwd change into a worktree - and
 * either one fails as "No conversation found with session ID".
 *
 * Copies, never moves, so switching back keeps working.
 */
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'fs'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { listOauthDirsForAgent } from '../db/providerInstances'
import { listRemoteClaudeConfigDirs } from './remote-gate'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('provider:claude:migrate')

export function defaultClaudeDir(): string {
  return join(homedir(), '.claude')
}

/**
 * All Claude config roots: every enabled oauth_dir + the default ~/.claude.
 * On a remote VM, also every ~/.claude* dir - per-instance dirs are forwarded
 * per session and never registered in the VM's provider_instances table, so
 * without the extra scan session scans and history loads miss their JSONLs.
 *
 * Lives here rather than in ipc/app so readers outside the IPC layer (fork)
 * can use it without importing a module that imports them back.
 */
export function claudeCandidateDirs(): string[] {
  return Array.from(new Set([
    ...listOauthDirsForAgent('claude-code'),
    defaultClaudeDir(),
    ...(process.env.SWITCHBOARD_REMOTE ? listRemoteClaudeConfigDirs() : []),
  ]))
}

export type MigrateResult =
  | { ok: true; copied: boolean; from?: string }
  | { ok: false; reason: 'source-missing' | 'io-error'; detail?: string }

export interface SessionCopy {
  path: string
  mtimeMs: number
}

/**
 * Every `<sessionId>.jsonl` under `<dir>/projects/*`, newest first. One copy
 * per cwd the chat has run in, and only the last-appended one is complete.
 */
export function listClaudeSessionCopies(dir: string, sessionId: string): SessionCopy[] {
  const file = `${sessionId}.jsonl`
  const projects = join(dir, 'projects')
  let subs: string[]
  try {
    subs = readdirSync(projects)
  } catch (err) {
    // Unreadable profile (usually never run) is not a source. Must not throw:
    // this runs mid-turn.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') log.warn(`cannot scan ${projects}: ${code ?? String(err)}`)
    return []
  }
  const found: SessionCopy[] = []
  for (const sub of subs) {
    const path = join(projects, sub, file)
    try {
      // throwIfNoEntry covers ENOENT only; EACCES still throws, and this runs
      // mid-turn where a throw would wedge the query.
      const st = statSync(path, { throwIfNoEntry: false })
      if (st) found.push({ path, mtimeMs: st.mtimeMs })
    } catch (err) {
      log.warn(`cannot stat ${path}: ${(err as { code?: string }).code ?? String(err)}`)
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Encoded cwd first, else the newest copy anywhere under `projects/`.
 * Newest, not first: readdir lists a repo before its worktrees, and taking
 * that re-filed a 1-turn transcript over a 21-turn one.
 */
export function findClaudeSessionFile(dir: string, sessionId: string, cwd: string): string | null {
  const exact = claudeSessionResumePath(dir, sessionId, cwd)
  if (existsSync(exact)) return exact
  return listClaudeSessionCopies(dir, sessionId)[0]?.path ?? null
}

/**
 * Exact resume path only, no scan. A scan answers "exists somewhere", which is
 * not the same question and skipped the copy this module exists to make.
 */
export function claudeSessionResumableIn(dir: string, sessionId: string, cwd: string): boolean {
  return existsSync(claudeSessionResumePath(dir, sessionId, cwd))
}

/** Where a transcript must sit for `--resume` to find it. */
export function claudeSessionResumePath(dir: string, sessionId: string, cwd: string): string {
  return join(dir, 'projects', encodeClaudeProjectPath(cwd), `${sessionId}.jsonl`)
}

/**
 * Put the freshest copy at the resume path. Call before every query carrying a
 * resume id.
 *
 * Freshest, not "any copy exists": A -> B -> A leaves A's copy frozen at the
 * first switch, so existence resumes a transcript missing every turn under B.
 * Never overwrites a newer destination.
 */
export function ensureClaudeSessionResumable(opts: {
  sessionId: string
  cwd: string
  /** Resolved CLAUDE_CONFIG_DIR the query will run under. */
  toDir: string
  /** Every known CLAUDE_CONFIG_DIR, including `toDir`. */
  candidates: string[]
}): MigrateResult {
  const dirs = Array.from(new Set([opts.toDir, ...opts.candidates]))
  const copies = dirs
    .flatMap((dir) => listClaudeSessionCopies(dir, opts.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (copies.length === 0) return { ok: false, reason: 'source-missing' }

  const dstPath = claudeSessionResumePath(opts.toDir, opts.sessionId, opts.cwd)
  const newest = copies[0]
  if (newest.path === dstPath) return { ok: true, copied: false }

  const dst = copies.find((c) => c.path === dstPath)
  if (dst && dst.mtimeMs >= newest.mtimeMs) return { ok: true, copied: false }

  return copyToResumePath(newest.path, dstPath)
}

function copyToResumePath(srcPath: string, dstPath: string): MigrateResult {
  try {
    mkdirSync(dirname(dstPath), { recursive: true })
    copyFileSync(srcPath, dstPath)
    log.info(`re-filed transcript: ${srcPath} → ${dstPath}`)
    return { ok: true, copied: true, from: srcPath }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`copy failed: ${srcPath} → ${dstPath}: ${msg}`)
    return { ok: false, reason: 'io-error', detail: msg }
  }
}

/**
 * Why resume failed. "Switch profile" is misleading when the profile is right
 * and the cwd moved, so the message is picked by looking, not guessing.
 */
export type TranscriptWhereabouts =
  | { kind: 'resumable' }
  | { kind: 'other-project-dir'; path: string }
  | { kind: 'other-profile'; dir: string; path: string }
  | { kind: 'unknown' }

export function locateResumeTranscript(opts: {
  sessionId: string
  cwd: string
  activeDir: string
  candidateDirs: string[]
}): TranscriptWhereabouts {
  if (claudeSessionResumableIn(opts.activeDir, opts.sessionId, opts.cwd)) {
    return { kind: 'resumable' }
  }
  const inActive = findClaudeSessionFile(opts.activeDir, opts.sessionId, opts.cwd)
  if (inActive) return { kind: 'other-project-dir', path: inActive }

  for (const dir of opts.candidateDirs) {
    if (dir === opts.activeDir) continue
    const hit = findClaudeSessionFile(dir, opts.sessionId, opts.cwd)
    if (hit) return { kind: 'other-profile', dir, path: hit }
  }
  return { kind: 'unknown' }
}

/** Chat copy for a failed resume. The user's next move differs per branch. */
export function describeResumeFailure(where: TranscriptWhereabouts): string {
  switch (where.kind) {
    case 'other-project-dir':
      return (
        'Claude files history per project folder, and this conversation started in a different ' +
        'folder from the one it is running in now, so Claude cannot see its history. ' +
        'Nothing is lost. Send the message again to retry.'
      )
    case 'other-profile':
      return (
        'This conversation was started under a different profile and its history is not available here. ' +
        `The transcript is in ${basename(where.dir)}. Your context is safe - switch to that profile to resume it.`
      )
    case 'unknown':
      return (
        'Claude has no transcript for this conversation, so the agent cannot resume its context. ' +
        'Your messages here are safe. If it belongs to a profile that is not set up in Switchboard, ' +
        'add it under Settings > Providers and switch to it. Otherwise the next message starts a ' +
        'fresh Claude session.'
      )
    case 'resumable':
      return 'Claude could not resume this conversation, but its transcript is where it should be. Send the message again to retry.'
  }
}
