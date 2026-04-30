/**
 * Pure fuzzy-match scorer used by the ⌘P quick-open modal.
 * Lives in its own file so unit tests can import it without dragging
 * React/zustand into a Node-environment test.
 *
 * Heuristic: characters in `query` must appear in `target` in order.
 * We reward consecutive runs (so "abc" scores higher in "abc.ts" than
 * "aXbXc.ts") and matches inside the basename (slash-tail). Length tie-
 * breaker prefers shorter targets so `App.tsx` wins over `OldAppShell.tsx`
 * for the query "app".
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let consec = 0
  const slash = t.lastIndexOf('/')
  const baseStart = slash === -1 ? 0 : slash + 1
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi += 1
      score += 1 + consec * 2
      if (i >= baseStart) score += 2
      consec += 1
    } else {
      consec = 0
    }
  }
  if (qi < q.length) return null
  return score - target.length * 0.01
}
