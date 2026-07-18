/**
 * Worktree drift detection. When a session's agent works inside a git
 * worktree other than the session's folder, the registry surfaces a
 * worktree.drift event so the user can follow it (one pointer drives the
 * branch chip, IDE pane, terminal cwd, and diff review).
 *
 * Provider-agnostic by construction: it feeds on the normalized tool.started
 * / turn.completed events all three adapters emit. Notably it does NOT use
 * tool.completed - the Claude adapter never emits one. Instead, command
 * checks are deferred to the thread's NEXT event: agents execute tools
 * sequentially within a turn, so a later tool.started (or the turn's end)
 * implies the stashed command has finished and any worktree it created
 * exists on disk.
 *
 * The per-provider surface is only the input-shape tables below, pinned by
 * tests with each adapter's real wire shapes.
 */
import type { RuntimeWorktreeDriftEvent } from '@shared/provider-events'

/** Tool names that mutate files, lowercase. Reads never signal drift. */
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch'])

/** Command-executing tools: claude 'Bash', codex commandExecution (normalized
 *  to 'Bash'), opencode ACP kind 'execute'. */
const COMMAND_TOOLS = new Set(['bash', 'execute', 'shell'])

/** Claude Code's dedicated worktree tool. Its input names a worktree/branch
 *  (not a path), so we resolve the name against `git worktree list` on the
 *  next event - catches the move even when the agent only reads in the new
 *  worktree, instead of waiting for the first write a few commands later. */
const WORKTREE_ENTER_TOOLS = new Set(['enterworktree'])

/** The worktree/branch name from an EnterWorktree call, or null. */
export function extractEnterWorktreeName(toolName: string, input: unknown): string | null {
  if (!WORKTREE_ENTER_TOOLS.has(firstToken(toolName))) return null
  if (typeof input !== 'object' || input === null) return null
  const obj = input as Record<string, unknown>
  for (const key of ['name', 'branch', 'worktree']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
  }
  return null
}

/**
 * OpenCode's ACP adapter emits toolName as `title || kind`, and titles are
 * free-form ('Write src/foo.ts'). Match on the first token so display-shaped
 * names still classify.
 */
const firstToken = (name: string): string => name.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''

/** Pull absolute file paths out of a write-tool input, tolerating any shape. */
export function extractWritePaths(toolName: string, input: unknown): string[] {
  if (!WRITE_TOOLS.has(firstToken(toolName))) return []
  if (typeof input !== 'object' || input === null) return []
  const obj = input as Record<string, unknown>
  const out: string[] = []
  for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
    if (typeof obj[key] === 'string' && obj[key]) out.push(obj[key] as string)
  }
  // Codex fileChange items: { changes: [{ path }, ...] }
  if (Array.isArray(obj.changes)) {
    for (const change of obj.changes) {
      const p = (change as Record<string, unknown> | null)?.path
      if (typeof p === 'string' && p) out.push(p)
    }
  }
  return out
}

export interface CommandSignal {
  paths: string[]
  /** The command can change worktree topology (git worktree ...) - the
   *  post-command check must bypass the worktree-list cache. */
  mutatesWorktrees: boolean
}

/**
 * Path candidates in a shell command: an explicit cwd field (codex sends
 * one), quoted absolute or dot-relative paths (agents quote paths with
 * spaces - Switchboard's own session worktrees live under "Application
 * Support"), bare absolute tokens, and ./ ../ tokens resolved against the
 * session folder (the canonical `git worktree add ../feature-x` form). A
 * candidate only matters if it lands under a KNOWN worktree of the session's
 * repo, so downstream false positives are structurally impossible.
 */
export function extractCommandPaths(toolName: string, input: unknown, baseCwd?: string): CommandSignal {
  const none: CommandSignal = { paths: [], mutatesWorktrees: false }
  if (!COMMAND_TOOLS.has(firstToken(toolName))) return none
  if (typeof input !== 'object' || input === null) return none
  const obj = input as Record<string, unknown>
  const out: string[] = []
  const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
  if (typeof obj.cwd === 'string' && isAbs(obj.cwd)) out.push(obj.cwd)
  const command = typeof obj.command === 'string' ? obj.command : ''
  if (command) {
    // Quoted (may contain spaces), then bare tokens; both accept unix and
    // drive-letter absolutes plus ./ ../ relatives.
    for (const m of command.matchAll(/["']((?:\/|[A-Za-z]:[\\/]|\.{1,2}\/)[^"']+)["']/g)) out.push(m[1])
    for (const m of command.matchAll(/(?:^|[\s=;|&(<>])((?:\/|[A-Za-z]:[\\/]|\.{1,2}\/)[A-Za-z0-9._~\\/-]+)/g)) out.push(m[1])
  }
  const resolved = out
    .map((p) => {
      if (isAbs(p)) return toPosix(p)
      if (!baseCwd) return null
      const stack = toPosix(baseCwd).split('/')
      for (const seg of toPosix(p).split('/')) {
        if (seg === '.' || seg === '') continue
        else if (seg === '..') stack.pop()
        else stack.push(seg)
      }
      return stack.join('/') || '/'
    })
    .filter((p): p is string => !!p)
  return { paths: [...new Set(resolved)], mutatesWorktrees: /\bworktree\b/.test(command) }
}

export interface WorktreeRef {
  path: string
  branch: string
}

/** All comparisons happen in posix form - Windows mixes drive-letter
 *  backslash paths (fs APIs) with forward slashes (git porcelain), and
 *  prefix matching must not care which producer a path came from. */
export const toPosix = (p: string): string => p.replace(/\\/g, '/')

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')

/** Longest-matching worktree root containing `p`, or null. */
function worktreeOf(p: string, worktrees: WorktreeRef[]): WorktreeRef | null {
  let best: WorktreeRef | null = null
  for (const wt of worktrees) {
    if (isUnder(p, wt.path) && (!best || wt.path.length > best.path.length)) best = wt
  }
  return best
}

/**
 * First path landing in a worktree other than the session's CONTAINING
 * worktree: subdir-rooted sessions do not false-positive at the repo root,
 * and worktree-rooted sessions treat the main checkout as foreign.
 * Longest-match matters throughout - .switchboard-style worktrees nest under
 * the repo root.
 */
export function detectDrift(
  sessionFolder: string,
  paths: string[],
  worktrees: WorktreeRef[]
): WorktreeRef | null {
  const home = worktreeOf(sessionFolder, worktrees)
  for (const p of paths) {
    const target = worktreeOf(p, worktrees)
    if (target && target.path !== home?.path) return target
  }
  return null
}

/**
 * Parse `git worktree list --porcelain` into refs, INCLUDING the main
 * checkout. (src/main/worktree.ts has a sibling parser that deliberately
 * excludes it - drift needs main so worktree-rooted sessions can detect
 * drift back into the main checkout.)
 */
export function parseWorktreeList(stdout: string): WorktreeRef[] {
  const out: WorktreeRef[] = []
  let current: Partial<WorktreeRef> = {}
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice('worktree '.length) }
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line.trim() === '') {
      if (current.path) out.push({ path: current.path, branch: current.branch ?? '(detached)' })
      current = {}
    }
  }
  if (current.path) out.push({ path: current.path, branch: current.branch ?? '(detached)' })
  return out
}

interface PendingCommands {
  paths: string[]
  needFresh: boolean
  /** EnterWorktree names to resolve against the fresh worktree list. */
  enterNames: string[]
}

/**
 * Stateful half. Lifecycle is turn-scoped:
 *  - write tools check at tool START (path known up front, cached list)
 *  - command tools stash their path candidates; the check runs on the
 *    thread's NEXT event (later tool.started or turn end), when the command
 *    has finished and any worktree it created exists
 *  - dedupe is per (thread, worktree) WITHIN a turn; the turn's end re-arms
 *    it, so an agent that keeps working in a foreign worktree re-suggests
 *    next turn (a dismissed banner is dismissed for the turn, not forever)
 * The worktree lister and path normalizer are injected: the registry supplies
 * its cached `git worktree list` and the shared realpath helper.
 */
export class DriftWatcher {
  private readonly notified = new Map<string, Set<string>>()
  private readonly pending = new Map<string, PendingCommands>()
  private readonly homeCache = new Map<string, string>()

  constructor(
    private readonly listWorktrees: (repoFolder: string, fresh?: boolean) => Promise<WorktreeRef[]>,
    private readonly normalize: (p: string) => Promise<string>
  ) {}

  async onToolStarted(
    threadId: string,
    sessionFolder: string,
    toolName: string,
    input: unknown
  ): Promise<RuntimeWorktreeDriftEvent | null> {
    // A new tool starting means the previously stashed command (if any) has
    // finished - flush it first.
    const flushed = await this.flushPending(threadId, sessionFolder)

    const enterName = extractEnterWorktreeName(toolName, input)
    if (enterName) {
      const existing = this.pending.get(threadId)
      this.pending.set(threadId, {
        paths: existing?.paths ?? [],
        needFresh: true, // the worktree may have just been created
        enterNames: [...(existing?.enterNames ?? []), enterName],
      })
      return flushed
    }

    const command = extractCommandPaths(toolName, input, sessionFolder)
    if (command.paths.length > 0) {
      const existing = this.pending.get(threadId)
      this.pending.set(threadId, {
        paths: [...(existing?.paths ?? []), ...command.paths].slice(-50),
        needFresh: (existing?.needFresh ?? false) || command.mutatesWorktrees,
        enterNames: existing?.enterNames ?? [],
      })
      return flushed
    }

    const writes = extractWritePaths(toolName, input)
    if (writes.length === 0) return flushed
    return flushed ?? (await this.check(threadId, sessionFolder, writes, false, []))
  }

  /** Flush any stashed command paths, then re-arm the per-turn dedupe. */
  async onTurnCompleted(threadId: string, sessionFolder: string): Promise<RuntimeWorktreeDriftEvent | null> {
    const event = await this.flushPending(threadId, sessionFolder)
    this.notified.delete(threadId)
    return event
  }

  onSessionStopped(threadId: string): void {
    this.notified.delete(threadId)
    this.pending.delete(threadId)
    this.homeCache.delete(threadId)
  }

  /** The session's folder pointer moved (user followed / swapped worktree). */
  onSessionMoved(threadId: string): void {
    this.notified.delete(threadId)
    this.homeCache.delete(threadId)
  }

  private async flushPending(threadId: string, sessionFolder: string): Promise<RuntimeWorktreeDriftEvent | null> {
    const stash = this.pending.get(threadId)
    if (!stash) return null
    this.pending.delete(threadId)
    return this.check(threadId, sessionFolder, stash.paths, stash.needFresh, stash.enterNames)
  }

  private async check(
    threadId: string,
    sessionFolder: string,
    paths: string[],
    fresh: boolean,
    enterNames: string[]
  ): Promise<RuntimeWorktreeDriftEvent | null> {
    if (paths.length === 0 && enterNames.length === 0) return null
    const listed = await this.listWorktrees(sessionFolder, fresh)
    // Single-worktree repos cannot drift - the overwhelmingly common case.
    if (listed.length <= 1) return null
    const worktrees = listed.map((wt) => ({ ...wt, path: toPosix(wt.path) }))

    // Resolve EnterWorktree names to worktree paths (branch or dir basename).
    const enterPaths = enterNames
      .map((name) => worktrees.find((w) => w.branch === name || w.path.split('/').pop() === name)?.path)
      .filter((p): p is string => !!p)

    let home = this.homeCache.get(threadId)
    if (!home) {
      home = toPosix(await this.normalize(sessionFolder))
      this.homeCache.set(threadId, home)
    }
    const normalizedPaths = [
      ...enterPaths, // already canonical from `git worktree list`
      ...(await Promise.all(paths.map(async (p) => toPosix(await this.normalize(p))))),
    ]
    const drift = detectDrift(home, normalizedPaths, worktrees)
    if (!drift) return null

    const seen = this.notified.get(threadId) ?? new Set<string>()
    if (seen.has(drift.path)) return null
    seen.add(drift.path)
    this.notified.set(threadId, seen)
    return { type: 'worktree.drift', threadId, worktreePath: drift.path, branch: drift.branch }
  }
}
