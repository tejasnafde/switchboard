/**
 * Parse `git diff HEAD --no-color -- <file>` output into per-line hunks
 * the editor's gutter extension can paint.
 *
 *   - kind 'add' — lines added in the working tree, no surrounding deletions
 *   - kind 'del' — lines removed; anchored to the line *after* the deletion
 *     in the new file so the gutter shows a marker the user can still see
 *   - kind 'mod' — paired add/del (line N replaced by line N')
 *
 * For a hunk header `@@ -a,b +c,d @@`:
 *   - `c..c+d-1` is the added range in the new file
 *   - if any `-` lines exist within the body we classify the overlapping
 *     `+` lines as `mod`; non-overlapping `+` lines are `add`; orphan
 *     `-` runs become a single `del` anchored at the new-file position
 *
 * We don't try to be cleverer than git here — patches with rename
 * markers, binary files, or `--` mode lines just contribute zero hunks.
 */
export interface DiffHunk {
  kind: 'add' | 'del' | 'mod'
  startLine: number
  endLine: number
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(diff: string): DiffHunk[] {
  if (!diff) return []
  const hunks: DiffHunk[] = []
  const lines = diff.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = HUNK_HEADER_RE.exec(line)
    if (!m) {
      i++
      continue
    }
    const newStart = parseInt(m[3], 10)
    const newCount = m[4] === undefined ? 1 : parseInt(m[4], 10)
    i++
    // Walk the body until the next hunk header or diff line. Track
    // adds and dels with their relative positions in the new file.
    const adds: number[] = []  // line numbers in new file
    let dels = 0               // count; anchored at current new-file pos when finalized
    let cursor = newStart
    let anchorForDel = newStart
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      const l = lines[i]
      if (l.startsWith('+') && !l.startsWith('+++')) {
        adds.push(cursor)
        cursor++
      } else if (l.startsWith('-') && !l.startsWith('---')) {
        dels++
        // del anchor stays at the current new-file cursor so the gutter
        // marker hangs on the line where the user would see "stuff was
        // removed before here".
        anchorForDel = cursor
      } else if (l.startsWith(' ')) {
        cursor++
      }
      // Skip "\ No newline at end of file" and stray lines silently
      i++
    }
    // Classify: pair `dels` with the first `dels` of `adds` as `mod`,
    // remaining adds become `add`. If only dels (no adds), emit a `del`.
    const modPaired = Math.min(adds.length, dels)
    if (modPaired > 0) {
      hunks.push({
        kind: 'mod',
        startLine: adds[0],
        endLine: adds[modPaired - 1],
      })
    }
    if (adds.length > modPaired) {
      hunks.push({
        kind: 'add',
        startLine: adds[modPaired],
        endLine: adds[adds.length - 1],
      })
    }
    if (dels > 0 && adds.length === 0) {
      hunks.push({ kind: 'del', startLine: anchorForDel, endLine: anchorForDel })
    }
    if (newCount === 0 && dels > 0) {
      // Pure deletion at end of file — newCount can be 0 with newStart
      // pointing one *before* the first surviving line. Anchor the del
      // marker on `newStart + 1` so it shows up on a real line.
      const last = hunks[hunks.length - 1]
      if (last && last.kind === 'del') {
        last.startLine = newStart + 1
        last.endLine = newStart + 1
      }
    }
  }
  return hunks
}
