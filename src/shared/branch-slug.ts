/**
 * Path/branch-safe slug for fork-to-worktree branches.
 *
 * Used by `forkConversation` (when `withWorktree: true`) to derive both
 * the new git branch name and the worktree directory name from a summary
 * of the message the user forked at.
 *
 * Rules (kept deliberately tight so the output is safe on every shell,
 * Windows path component, and `git check-ref-format`):
 *
 *   - lower-case
 *   - non-alphanumerics collapse to a single `-`
 *   - leading / trailing `-` stripped
 *   - capped at 40 chars (slice happens before the final trim so we
 *     don't end on a stray dash)
 *   - empty input → `fork`
 *   - `fork/` prefix added unconditionally (callers that don't want the
 *     prefix can use `slugifyForBranch` directly)
 *
 * Branches inside `fork/<slug>` are easy to grep, easy to delete in
 * bulk (`git branch -D fork/*`), and visually distinct from kanban-card
 * branches which use `kanban/<slug>` (see `src/main/worktree.ts`).
 */

const MAX_SLUG_LEN = 40

/** Internal: the part after `fork/`. Exported for tests + reuse. */
export function slugifyForBranch(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LEN)
    .replace(/(^-|-$)/g, '')
  return cleaned || 'fork'
}

export function makeBranchSlug(summary: string): string {
  return `fork/${slugifyForBranch(summary)}`
}
