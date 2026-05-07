/**
 * Pure ranking + filtering for the branch-picker popover. Keeping the
 * sort/filter logic out of the React component lets us unit-test the
 * "current first, locals before remotes, alphabetical within group,
 * substring filter" rules without a DOM.
 *
 * The Ref shape mirrors the main-process Ref from `src/main/git/refs.ts`
 * exactly. We don't import that type here because main-process modules
 * are not in the renderer tsconfig path; the duplication is a deliberate
 * cross-process boundary marker.
 */
export interface Ref {
  name: string
  sha: string
  current: boolean
  isRemote: boolean
  worktreePath: string | null
}

function compareName(a: Ref, b: Ref): number {
  return a.name.localeCompare(b.name)
}

/**
 * Sort + filter refs for the popover.
 *
 * Sort:
 *   1. The currently-checked-out ref always wins (one slot).
 *   2. Then all other LOCAL refs, alphabetical.
 *   3. Then all REMOTE refs, alphabetical.
 *
 * Filter: case-insensitive substring match against `name`. Whitespace-only
 * queries are treated as no filter so the user sees the full list.
 */
export function rankAndFilterRefs(refs: ReadonlyArray<Ref>, query: string): Ref[] {
  const trimmed = query.trim().toLowerCase()
  const filter = (r: Ref) => trimmed === '' || r.name.toLowerCase().includes(trimmed)

  const matching = refs.filter(filter)
  const current = matching.filter((r) => r.current)
  const locals = matching.filter((r) => !r.current && !r.isRemote).sort(compareName)
  const remotes = matching.filter((r) => r.isRemote).sort(compareName)
  return [...current, ...locals, ...remotes]
}

/**
 * Decide what to do when the user picks a ref in the popover. Three
 * possible actions:
 *
 *   - `noop`: nothing to change — picked ref is already checked out
 *     in the session's current cwd.
 *   - `checkout`: run `git checkout <refName>` in `cwd`. Used when the
 *     ref has no associated worktree, OR when the ref is remote (in
 *     which case we strip the `<remote>/` prefix so git creates a
 *     local tracking branch instead of leaving us in detached HEAD).
 *   - `swap-cwd`: don't run any git command — the picked branch already
 *     has a worktree elsewhere on disk; the right move is to point the
 *     session at that worktree.
 */
export type SwitchAction =
  | { kind: 'noop' }
  | { kind: 'checkout'; cwd: string; refName: string }
  | { kind: 'swap-cwd'; newCwd: string; refName: string }

export function decideSwitchAction(ref: Ref, currentCwd: string): SwitchAction {
  if (ref.current) return { kind: 'noop' }
  if (ref.worktreePath) {
    if (ref.worktreePath === currentCwd) return { kind: 'noop' }
    return { kind: 'swap-cwd', newCwd: ref.worktreePath, refName: ref.name }
  }
  // Remote ref: strip leading `<remote>/` so `git checkout` falls back
  // to its tracking-branch shorthand. Locals pass through unchanged.
  const refName = ref.isRemote && ref.name.includes('/') ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name
  return { kind: 'checkout', cwd: currentCwd, refName }
}
