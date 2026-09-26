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

export function classifyWorktree(row: WorktreeRow): WorktreeCategory {
  if (row.owned) return 'in_use'
  if (row.protectedBy || row.locked) return 'protected'
  if (!row.git) return 'has_changes'
  if (row.git.uncommittedFiles > 0 || row.git.unpushedCommits > 0) return 'has_changes'
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
export function removalVerdict(row: WorktreeRow, ack: WorktreeRemovalAck | null): WorktreeRemovalVerdict {
  if (row.owned) {
    return { ok: false, reason: 'This worktree is in use. Remove it from the chat or card that owns it.' }
  }
  if (row.protectedBy === 'project') return { ok: false, reason: 'This project is protected; its worktrees are never removed here.' }
  if (row.protectedBy === 'worktree') return { ok: false, reason: 'This worktree is protected.' }
  if (row.locked) return { ok: false, reason: 'Git has this worktree locked. Unlock it with `git worktree unlock` first.' }
  if (!row.git) return { ok: false, reason: 'Could not read the git state of this worktree, so it is not removed.' }
  const { uncommittedFiles, unpushedCommits } = row.git
  if (uncommittedFiles > 0 || unpushedCommits > 0) {
    if (!ack) return { ok: false, reason: `Removing this worktree would lose ${lossSummary(row.git)}; it needs a confirm.` }
    if (ack.uncommittedFiles < uncommittedFiles || ack.unpushedCommits < unpushedCommits) {
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
  if (git.unpushedCommits > 0) parts.push(plural(git.unpushedCommits, 'unpushed commit'))
  return parts.join(', ')
}

/** The confirm body for removing a worktree with changes: names every loss, and what survives. */
export function removalConfirmBody(row: WorktreeRow): string {
  const git = row.git
  if (!git) return ''
  const lines: string[] = []
  if (git.uncommittedFiles > 0) {
    lines.push(`${plural(git.uncommittedFiles, 'uncommitted file')} will be deleted and cannot be recovered.`)
  }
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
