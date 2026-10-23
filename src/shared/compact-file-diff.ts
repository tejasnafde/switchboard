/**
 * The read-only line diff a phone shows under a changed-file row. Both
 * contents come with the `file.edited` event or the history message, so this
 * runs on the client. Native Android's FileDiffPresenter applies the same
 * rules; both check tests/fixtures/compact-file-diff.json.
 *
 * Small files get an exact line alignment with 2 context lines around each
 * change and one "… N unchanged lines" row per skipped run, capped at
 * MAX_VISIBLE_ROWS. A file too large to align falls back to its common prefix
 * and suffix, and its counts are approximate.
 */

export type CompactDiffLineKind = 'context' | 'added' | 'removed' | 'omitted'

export interface CompactDiffLine {
  kind: CompactDiffLineKind
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface CompactFileDiff {
  lines: CompactDiffLine[]
  addedLines: number
  removedLines: number
  truncated: boolean
  countsExact: boolean
}

export const MAX_VISIBLE_ROWS = 160
const CONTEXT_LINES = 2
const MAX_ALIGNMENT_CELLS = 90_000
// Per-side bound: the cell product is zero when one side is empty.
const MAX_ALIGNMENT_LINES = 3_000
const MAX_LINE_CHARS = 320

export function compactFileDiff(oldContent: string, newContent: string): CompactFileDiff {
  const oldLines = diffLines(oldContent)
  const newLines = diffLines(newContent)
  return alignable(oldLines.length, newLines.length) ? exact(oldLines, newLines) : boundedFallback(oldLines, newLines)
}

export function alignable(oldSize: number, newSize: number): boolean {
  return oldSize <= MAX_ALIGNMENT_LINES && newSize <= MAX_ALIGNMENT_LINES && oldSize * newSize <= MAX_ALIGNMENT_CELLS
}

const line = (
  kind: CompactDiffLineKind,
  text: string,
  oldLine: number | null,
  newLine: number | null,
): CompactDiffLine => ({
  kind,
  text,
  oldLine,
  newLine,
})

function exact(oldLines: string[], newLines: string[]): CompactFileDiff {
  const width = newLines.length + 1
  const table = new Int32Array((oldLines.length + 1) * width)
  for (let o = oldLines.length - 1; o >= 0; o--) {
    for (let n = newLines.length - 1; n >= 0; n--) {
      table[o * width + n] =
        oldLines[o] === newLines[n]
          ? table[(o + 1) * width + n + 1] + 1
          : Math.max(table[(o + 1) * width + n], table[o * width + n + 1])
    }
  }

  const rows: CompactDiffLine[] = []
  let o = 0
  let n = 0
  let added = 0
  let removed = 0
  while (o < oldLines.length || n < newLines.length) {
    if (o < oldLines.length && n < newLines.length && oldLines[o] === newLines[n]) {
      rows.push(line('context', bounded(oldLines[o]), o + 1, n + 1))
      o++
      n++
    } else if (
      o < oldLines.length &&
      (n === newLines.length || table[(o + 1) * width + n] >= table[o * width + n + 1])
    ) {
      rows.push(line('removed', bounded(oldLines[o]), o + 1, null))
      removed++
      o++
    } else {
      rows.push(line('added', bounded(newLines[n]), null, n + 1))
      added++
      n++
    }
  }

  const compact = compactContext(rows)
  const visible = compact.slice(0, MAX_VISIBLE_ROWS)
  return {
    lines: visible,
    addedLines: added,
    removedLines: removed,
    truncated: compact.length > visible.length,
    countsExact: true,
  }
}

function boundedFallback(oldLines: string[], newLines: string[]): CompactFileDiff {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  if (oldChanged.length === 0 && newChanged.length === 0) {
    return { lines: [], addedLines: 0, removedLines: 0, truncated: false, countsExact: true }
  }
  const rows: CompactDiffLine[] = []
  for (let i = Math.max(0, prefix - CONTEXT_LINES); i < prefix; i++) {
    rows.push(line('context', bounded(oldLines[i]), i + 1, i + 1))
  }

  const mutationBudget = MAX_VISIBLE_ROWS - rows.length - Math.min(CONTEXT_LINES, suffix)
  const removedBudget = Math.min(oldChanged.length, Math.floor(mutationBudget / 2))
  const addedBudget = Math.min(newChanged.length, mutationBudget - removedBudget)
  oldChanged
    .slice(0, removedBudget)
    .forEach((text, i) => rows.push(line('removed', bounded(text), prefix + i + 1, null)))
  newChanged.slice(0, addedBudget).forEach((text, i) => rows.push(line('added', bounded(text), null, prefix + i + 1)))

  const omittedMutations = oldChanged.length - removedBudget + newChanged.length - addedBudget
  if (omittedMutations > 0 && rows.length < MAX_VISIBLE_ROWS) {
    rows.push(
      line(
        'omitted',
        `… ${omittedMutations} changed ${omittedMutations === 1 ? 'line' : 'lines'} not shown`,
        null,
        null,
      ),
    )
  }
  const suffixBudget = Math.min(CONTEXT_LINES, suffix, MAX_VISIBLE_ROWS - rows.length)
  for (let offset = 0; offset < suffixBudget; offset++) {
    const oldIndex = oldLines.length - suffix + offset
    const newIndex = newLines.length - suffix + offset
    rows.push(line('context', bounded(oldLines[oldIndex]), oldIndex + 1, newIndex + 1))
  }

  return {
    lines: rows,
    addedLines: newChanged.length,
    removedLines: oldChanged.length,
    truncated: omittedMutations > 0,
    countsExact: false,
  }
}

function compactContext(rows: CompactDiffLine[]): CompactDiffLine[] {
  const visible = new Array<boolean>(rows.length).fill(false)
  let anyChange = false
  rows.forEach((row, index) => {
    if (row.kind === 'context') return
    anyChange = true
    for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(rows.length - 1, index + CONTEXT_LINES); i++) {
      visible[i] = true
    }
  })
  if (!anyChange) return []
  const compact: CompactDiffLine[] = []
  let index = 0
  while (index < rows.length) {
    if (visible[index]) {
      compact.push(rows[index])
      index++
    } else {
      const start = index
      while (index < rows.length && !visible[index]) index++
      compact.push(
        line('omitted', `… ${index - start} unchanged ${index - start === 1 ? 'line' : 'lines'}`, null, null),
      )
    }
  }
  return compact
}

function bounded(text: string): string {
  return text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS - 1)}…`
}

function diffLines(content: string): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
