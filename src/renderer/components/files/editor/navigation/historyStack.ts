/**
 * Per-session back/forward navigation history. Pure data structure +
 * pure transitions — owned by editor-store, mutated through these
 * helpers so the stack semantics are consistent everywhere a "jump"
 * happens (file pill click, ⌘P open, ⌘-click to definition, etc.).
 *
 * Two-stack model: one for visited entries, one for the cursor index.
 * After `back`, calling `push` truncates the forward stack (VS Code
 * convention; matches every browser back-button you've ever used).
 *
 * Coalescing: consecutive pushes of the same path within ~10 lines
 * collapse onto the latest entry — the user moving their cursor a
 * couple lines down or clicking around inside the same function should
 * not flood history. A line-delta of 10 mirrors VS Code's heuristic.
 */
export interface NavEntry {
  path: string
  line: number
  ch: number
}

export interface HistoryStack {
  /** Visited entries in chronological order. cursor points at the active one. */
  entries: ReadonlyArray<NavEntry>
  /** Index into `entries` (0 = oldest, length-1 = newest). -1 if empty. */
  cursor: number
  cap: number
}

const COALESCE_LINE_DELTA = 10

export function createHistoryStack(cap = 50): HistoryStack {
  return { entries: [], cursor: -1, cap }
}

export function current(s: HistoryStack): NavEntry | null {
  if (s.cursor < 0) return null
  return s.entries[s.cursor] ?? null
}

export function canBack(s: HistoryStack): boolean {
  return s.cursor > 0
}

export function canForward(s: HistoryStack): boolean {
  return s.cursor >= 0 && s.cursor < s.entries.length - 1
}

export function back(s: HistoryStack): HistoryStack {
  if (!canBack(s)) return s
  return { ...s, cursor: s.cursor - 1 }
}

export function forward(s: HistoryStack): HistoryStack {
  if (!canForward(s)) return s
  return { ...s, cursor: s.cursor + 1 }
}

export function push(s: HistoryStack, entry: NavEntry): HistoryStack {
  const cur = current(s)
  // Coalesce: same path + small line drift → replace the current entry.
  if (
    cur &&
    cur.path === entry.path &&
    Math.abs(cur.line - entry.line) <= COALESCE_LINE_DELTA
  ) {
    const replaced = [...s.entries.slice(0, s.cursor), entry]
    return { ...s, entries: replaced, cursor: replaced.length - 1 }
  }
  // Truncate any forward branch, then append.
  const truncated = s.entries.slice(0, s.cursor + 1)
  const appended = [...truncated, entry]
  // Cap: drop oldest if past limit.
  const overflow = appended.length - s.cap
  const final = overflow > 0 ? appended.slice(overflow) : appended
  return { ...s, entries: final, cursor: final.length - 1 }
}
