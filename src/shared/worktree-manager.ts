/**
 * The worktree manager's contract and rules: what a worktree row carries,
 * which filter tab it falls under, what removing it would lose, and whether
 * the backend may remove it.
 *
 * The backend holds the rules. It re-reads git state at removal time and
 * refuses when the losses have grown past what the user confirmed, so a
 * client that confirmed "1 uncommitted file" cannot remove a worktree that
 * now has five.
 */

export interface WorktreeGitState {
  /** Lines of `git status --porcelain`: modified, staged and untracked entries. */
  uncommittedFiles: number
  /**
   * Ignored entries that are not regenerable build output (a `.env`, local
   * config). `git worktree remove` deletes them without `--force`, so they
   * count as a loss like uncommitted files. A fully ignored folder is one entry.
   */
  ignoredFiles: number
  /** The first few of those entries, for the confirm and the row label. */
  ignoredSample: string[]
  /** Commits reachable from this worktree's HEAD and from no other branch or remote. */
  unpushedCommits: number
  /** HEAD is an ancestor of the repository's default branch. */
  merged: boolean
}

export interface WorktreeChatLink {
  kind: 'chat' | 'card'
  id: string
  title: string
  archived: boolean
}

export type WorktreeProtectionSource = 'project' | 'worktree'

export interface WorktreeRow {
  projectPath: string
  projectName: string
  path: string
  branch: string | null
  head: string
  /** Git reports the directory missing. Removing only prunes its metadata. */
  prunable: boolean
  /** `git worktree lock`ed. Treated as protected. */
  locked: boolean
  /** A chat, card, worktree catalog entry or project owns the path. */
  owned: boolean
  chat: WorktreeChatLink | null
  protectedBy: WorktreeProtectionSource | null
  /** Null when git could not be read; such a row is never offered for removal. */
  git: WorktreeGitState | null
}

export interface WorktreeInventory {
  rows: WorktreeRow[]
  /** Projects whose worktrees could not be listed. Non-git projects are skipped silently. */
  errors: Array<{ projectPath: string; message: string }>
}

export interface WorktreeProtection {
  projects: string[]
  worktrees: string[]
}

/** The settings row holding `WorktreeProtection` as JSON, on the backend that owns the worktrees. */
export const WORKTREE_PROTECTION_SETTING = 'worktrees.protection'

export function parseWorktreeProtection(raw: string | null | undefined): WorktreeProtection {
  if (!raw) return { projects: [], worktrees: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof WorktreeProtection, unknown>>
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))] : []
    return { projects: strings(parsed.projects), worktrees: strings(parsed.worktrees) }
  } catch {
    // A corrupt row protects nothing rather than blocking the page; the next
    // toggle rewrites it.
    return { projects: [], worktrees: [] }
  }
}

export function protectionSource(
  protection: WorktreeProtection,
  projectPath: string,
  worktreePath: string,
): WorktreeProtectionSource | null {
  if (protection.projects.includes(projectPath)) return 'project'
  if (protection.worktrees.includes(worktreePath)) return 'worktree'
  return null
}

export interface WorktreeProtectionPatch {
  target: 'project' | 'worktree'
  path: string
  protected: boolean
}

/** The patch as it arrives over IPC, where nothing but this checks its shape; null when malformed. */
export function parseProtectionPatch(value: unknown): WorktreeProtectionPatch | null {
  if (!value || typeof value !== 'object') return null
  const { target, path, protected: on } = value as Record<string, unknown>
  if (target !== 'project' && target !== 'worktree') return null
  if (typeof path !== 'string' || !isAbsolutePath(path)) return null
  if (typeof on !== 'boolean') return null
  return { target, path, protected: on }
}

/** POSIX or Windows absolute; `node:path` is not available to the shared layer. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export function applyProtectionPatch(protection: WorktreeProtection, patch: WorktreeProtectionPatch): WorktreeProtection {
  const key = patch.target === 'project' ? 'projects' : 'worktrees'
  const without = protection[key].filter((p) => p !== patch.path)
  return { ...protection, [key]: patch.protected ? [...without, patch.path] : without }
}

/**
 * The filter a row belongs to. `protected` rows are hidden from every tab;
 * `has_changes` includes a row whose git state could not be read, since
 * nothing about it is known to be safe.
 */
export type WorktreeCategory = 'in_use' | 'protected' | 'has_changes' | 'safe'

/**
 * Ignored output a build or an install recreates, so losing it loses no work.
 * Matched on the entry's top-level folder; `node_modules` anywhere, since a
 * monorepo keeps one per package.
 */
export const REGENERABLE_IGNORED_DIRS: readonly string[] = [
  'node_modules', 'dist', 'out', 'build', '.next', '.nuxt', '.svelte-kit', 'coverage',
  '.turbo', '.cache', '.parcel-cache', '.vite', 'target', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.gradle', '.dart_tool', '.expo',
]

export function isRegenerableIgnored(entry: string): boolean {
  const segments = entry.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0) return false
  return REGENERABLE_IGNORED_DIRS.includes(segments[0]) || segments.includes('node_modules')
}

/**
 * The ignored entries that hold local work, from `git ls-files -o -i
 * --exclude-standard --directory`. That listing also names a folder whose
 * only ignored content is listed on its own (`pkg/` beside
 * `pkg/node_modules/`); such a container is dropped, so it neither counts nor
 * hides what it holds.
 */
export function ignoredLosses(entries: readonly string[]): string[] {
  const clean = entries.map((e) => e.replace(/\\/g, '/')).filter((e) => e !== '')
  return clean.filter((entry) =>
    !isRegenerableIgnored(entry) &&
    !(entry.endsWith('/') && clean.some((other) => other !== entry && other.startsWith(entry))))
}

export function classifyWorktree(row: WorktreeRow): WorktreeCategory {
  if (row.owned) return 'in_use'
  if (row.protectedBy || row.locked) return 'protected'
  if (!row.git) return 'has_changes'
  if (row.git.uncommittedFiles > 0 || row.git.ignoredFiles > 0 || row.git.unpushedCommits > 0) return 'has_changes'
  return 'safe'
}

export type WorktreeFilter = 'all' | 'safe' | 'has_changes' | 'in_use'

export const WORKTREE_FILTERS: ReadonlyArray<{ id: WorktreeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'safe', label: 'Safe to remove' },
  { id: 'has_changes', label: 'Has changes' },
  { id: 'in_use', label: 'In use' },
]

export function matchesFilter(row: WorktreeRow, filter: WorktreeFilter): boolean {
  const category = classifyWorktree(row)
  if (category === 'protected') return false
  return filter === 'all' || category === filter
}

export function filterCounts(rows: readonly WorktreeRow[]): Record<WorktreeFilter, number> {
  const counts: Record<WorktreeFilter, number> = { all: 0, safe: 0, has_changes: 0, in_use: 0 }
  for (const row of rows) {
    for (const f of WORKTREE_FILTERS) if (matchesFilter(row, f.id)) counts[f.id] += 1
  }
  return counts
}

/** What removal throws away, as the client confirmed it. */
export interface WorktreeRemovalAck {
  uncommittedFiles: number
  unpushedCommits: number
  ignoredFiles: number
}

const ACK_FIELDS = ['uncommittedFiles', 'unpushedCommits', 'ignoredFiles'] as const

/**
 * The acknowledgement as it arrives over IPC. Null or absent means nothing
 * was acknowledged. Anything else must be exactly the three counts, each a
 * non-negative integer: a missing or non-numeric count would otherwise pass
 * the loss comparison (`undefined < 3` is false) and let a dirty worktree be
 * force-removed without a real confirm.
 */
export function parseRemovalAck(value: unknown): { ok: true; ack: WorktreeRemovalAck | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, ack: null }
  const invalid = (why: string) => ({ ok: false as const, error: `Invalid removal confirmation: ${why}.` })
  if (typeof value !== 'object' || Array.isArray(value)) return invalid('expected an object of counts')
  const fields = Object.keys(value)
  const unknown = fields.filter((f) => !(ACK_FIELDS as readonly string[]).includes(f))
  if (unknown.length > 0) return invalid(`unknown field ${unknown.join(', ')}`)
  const record = value as Record<string, unknown>
  for (const field of ACK_FIELDS) {
    const n = record[field]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return invalid(`${field} must be a whole number of 0 or more`)
  }
  return {
    ok: true,
    ack: { uncommittedFiles: record.uncommittedFiles as number, unpushedCommits: record.unpushedCommits as number, ignoredFiles: record.ignoredFiles as number },
  }
}

export type WorktreeRemovalVerdict =
  | { ok: true; force: boolean; deleteBranch: string | null }
  | { ok: false; reason: string }

/**
 * Whether the backend may remove `row`, judged on its CURRENT state.
 *
 * - Owned, protected and locked worktrees are refused outright.
 * - A row with unknown git state is refused: nothing about it is known safe.
 * - Uncommitted files or unpushed commits need an acknowledgement covering at
 *   least what is there now.
 * - `--force` only when there are uncommitted files (git refuses otherwise).
 * - The branch is deleted only when it holds no commit found nowhere else.
 */
export function removalVerdict(row: WorktreeRow, rawAck: unknown): WorktreeRemovalVerdict {
  // Checked here as well as at the IPC boundary, so no caller can skip it.
  const parsed = parseRemovalAck(rawAck)
  if (!parsed.ok) return { ok: false, reason: parsed.error }
  const { ack } = parsed
  if (row.owned) {
    return { ok: false, reason: 'This worktree is in use. Remove it from the chat or card that owns it.' }
  }
  if (row.protectedBy === 'project') return { ok: false, reason: 'This project is protected; its worktrees are never removed here.' }
  if (row.protectedBy === 'worktree') return { ok: false, reason: 'This worktree is protected.' }
  if (row.locked) return { ok: false, reason: 'Git has this worktree locked. Unlock it with `git worktree unlock` first.' }
  if (!row.git) return { ok: false, reason: 'Could not read the git state of this worktree, so it is not removed.' }
  const { uncommittedFiles, unpushedCommits, ignoredFiles } = row.git
  if (uncommittedFiles > 0 || unpushedCommits > 0 || ignoredFiles > 0) {
    if (!ack) return { ok: false, reason: `Removing this worktree would lose ${lossSummary(row.git)}; it needs a confirm.` }
    if (ack.uncommittedFiles < uncommittedFiles || ack.unpushedCommits < unpushedCommits || ack.ignoredFiles < ignoredFiles) {
      return { ok: false, reason: `The worktree changed since you confirmed: it now has ${lossSummary(row.git)}. Review it again.` }
    }
  }
  return {
    ok: true,
    force: uncommittedFiles > 0,
    deleteBranch: unpushedCommits === 0 ? row.branch : null,
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** "3 uncommitted files, 2 unpushed commits", or '' when nothing would be lost. */
export function lossSummary(git: WorktreeGitState): string {
  const parts: string[] = []
  if (git.uncommittedFiles > 0) parts.push(plural(git.uncommittedFiles, 'uncommitted file'))
  if (git.ignoredFiles > 0) parts.push(ignoredSummary(git))
  if (git.unpushedCommits > 0) parts.push(plural(git.unpushedCommits, 'unpushed commit'))
  return parts.join(', ')
}

/** ".env", ".env and 2 other ignored files", or "3 ignored files" when no name is known. */
export function ignoredSummary(git: WorktreeGitState): string {
  const [first] = git.ignoredSample
  if (!first) return plural(git.ignoredFiles, 'ignored file')
  if (git.ignoredFiles === 1) return `ignored ${first}`
  return `${first} and ${plural(git.ignoredFiles - 1, 'other ignored file')}`
}

/** The confirm body for removing a worktree with changes: names every loss, and what survives. */
export function removalConfirmBody(row: WorktreeRow): string {
  const git = row.git
  if (!git) return ''
  const lines: string[] = []
  const deleted = [
    git.uncommittedFiles > 0 ? plural(git.uncommittedFiles, 'uncommitted file') : null,
    git.ignoredFiles > 0 ? ignoredSummary(git) : null,
  ].filter(Boolean)
  if (deleted.length > 0) lines.push(`${deleted.join(' and ')} will be deleted and cannot be recovered.`)
  if (git.unpushedCommits > 0) {
    const one = git.unpushedCommits === 1
    const commits = `${plural(git.unpushedCommits, 'unpushed commit')} ${one ? 'exists' : 'exist'} nowhere else`
    lines.push(row.branch
      ? `${commits}. ${one ? 'It stays' : 'They stay'} on branch ${row.branch}, which is not deleted.`
      : `${commits} and, with a detached HEAD, will be lost.`)
  }
  return lines.join(' ')
}

export type WorktreeStateTone = 'muted' | 'warn' | 'lock'

export function gitStateLabel(row: WorktreeRow): { text: string; tone: WorktreeStateTone; title?: string } {
  switch (classifyWorktree(row)) {
    case 'in_use':
      return {
        text: 'In use',
        tone: 'lock',
        title: row.chat && !row.chat.archived
          ? 'Used by a live chat; it cannot be removed here'
          : 'Owned by a chat or card; remove it from there',
      }
    case 'protected':
      return { text: row.locked && !row.protectedBy ? 'Locked' : 'Protected', tone: 'lock' }
    default:
      break
  }
  if (!row.git) return { text: 'Git state unknown', tone: 'warn' }
  const loss = lossSummary(row.git)
  if (loss) return { text: loss, tone: 'warn' }
  if (row.prunable) return { text: 'Missing on disk', tone: 'muted' }
  return { text: row.git.merged ? 'Merged, clean' : 'Pushed, clean', tone: 'muted' }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Last path segment, for a project's display name when the DB has none. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}
