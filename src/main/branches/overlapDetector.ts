/**
 * Auto-suggest dependency edges by pairwise merge-tree probing.
 *
 * For each unordered pair of branches, we ask `git merge-tree
 * --write-tree` whether they conflict. Conflicting pairs become
 * suggested edges. The older branch (lower first-commit timestamp) is
 * picked as the parent — the working theory is "older branches are
 * foundations, newer ones build on them."
 *
 * Suggestions are necessary-not-sufficient: two branches can edit the
 * same file in non-conflicting ways (e.g. both add unrelated functions
 * to the bottom of `utils.ts`). Auto-detection produces a higher
 * false-positive rate than false-negative; the UI surfaces them as
 * dashed-line "suggested" edges and the user confirms or rejects.
 */

import type { BranchNode } from './dependencyGraph'
import type { MergeTreeResult } from '../worktree'

export interface SuggestedEdge {
  parent: string
  child: string
  conflictFiles: string[]
}

export interface OverlapDeps {
  /** Same shape as `worktree.ts:mergeTreeWriteTree`. */
  mergeTreeWriteTree: (cwd: string, base: string, head: string) => Promise<MergeTreeResult>
  /** Returns the unix-second timestamp of the branch's first commit
   *  (i.e. when the branch diverged). Used as the age heuristic. */
  branchTimestamp: (branch: string) => Promise<number>
  /** Optional predicate — if it returns true for `(parent, child)` or
   *  `(child, parent)`, no suggestion is emitted (an edge already
   *  exists). Lets callers de-dup against the persisted graph. */
  existingEdge?: (parent: string, child: string) => boolean
}

export async function detectOverlaps(
  nodes: BranchNode[],
  mainRepoPath: string,
  deps: OverlapDeps,
): Promise<SuggestedEdge[]> {
  if (nodes.length < 2) return []

  // Cache timestamps so we don't shell out twice for the same branch.
  const tsCache = new Map<string, number>()
  const ts = async (b: string): Promise<number> => {
    if (!tsCache.has(b)) tsCache.set(b, await deps.branchTimestamp(b))
    return tsCache.get(b)!
  }

  const out: SuggestedEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].branch
      const b = nodes[j].branch
      const merge = await deps.mergeTreeWriteTree(mainRepoPath, a, b)
      if (!merge.conflicted) continue
      const tsA = await ts(a)
      const tsB = await ts(b)
      const parent = tsA <= tsB ? a : b
      const child = parent === a ? b : a
      if (deps.existingEdge?.(parent, child) || deps.existingEdge?.(child, parent)) continue
      out.push({ parent, child, conflictFiles: merge.conflictFiles })
    }
  }
  return out
}
