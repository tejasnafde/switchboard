/**
 * Thin, pure wrapper over @pierre/diffs for the in-chat diff cards.
 *
 * Keeps the React-free bits (build a diff, apply a hunk decision, reconstruct
 * the file bytes) in one tested module so the write-back content is provably
 * correct independent of any rendering.
 *
 * Note on `resolvedContent`: @pierre/diffs stores each line WITH its own
 * trailing newline, so the file is reconstructed by joining with the empty
 * string - not '\n'.
 */
import {
  parseDiffFromFile,
  diffAcceptRejectHunk,
  type FileDiffMetadata,
} from '@pierre/diffs'

export type { FileDiffMetadata }

/** Build diff metadata from the baseline + the agent's new content. */
export function buildFileDiff(relPath: string, oldContent: string, newContent: string): FileDiffMetadata {
  return parseDiffFromFile(
    { name: relPath, contents: oldContent },
    { name: relPath, contents: newContent },
  )
}

/** Accept or reject a hunk (whole-hunk or block-level), returning new metadata. */
export function applyHunkDecision(
  fd: FileDiffMetadata,
  hunkIndex: number,
  options: Parameters<typeof diffAcceptRejectHunk>[2],
): FileDiffMetadata {
  return diffAcceptRejectHunk(fd, hunkIndex, options)
}

/** Reconstruct the file content represented by the (possibly resolved) diff. */
export function resolvedContent(fd: FileDiffMetadata): string {
  return fd.additionLines.join('')
}

export interface DiffRow {
  kind: 'context' | 'add' | 'del'
  /** Line text with the trailing newline stripped for display. */
  text: string
  /** 1-based old-file line number (absent on additions). */
  oldLine?: number
  /** 1-based new-file line number (absent on deletions). */
  newLine?: number
}

/** Strip a single trailing newline (lines come back with their own \n). */
function trimEol(s: string | undefined): string {
  return (s ?? '').replace(/\r?\n$/, '')
}

/**
 * Project one hunk into a flat list of unified-diff rows (context / add / del)
 * with line numbers, walking the hunk's content groups. Pure - used by the
 * card to render and unit-tested for correctness.
 */
export function hunkRows(fd: FileDiffMetadata, hunkIndex: number): DiffRow[] {
  const hunk = fd.hunks[hunkIndex]
  if (!hunk) return []
  const rows: DiffRow[] = []
  let oldLine = hunk.deletionStart
  let newLine = hunk.additionStart
  for (const part of hunk.hunkContent) {
    if (part.type === 'context') {
      for (let i = 0; i < part.lines; i++) {
        rows.push({
          kind: 'context',
          text: trimEol(fd.additionLines[part.additionLineIndex + i]),
          oldLine: oldLine++,
          newLine: newLine++,
        })
      }
    } else {
      for (let i = 0; i < part.deletions; i++) {
        rows.push({
          kind: 'del',
          text: trimEol(fd.deletionLines[part.deletionLineIndex + i]),
          oldLine: oldLine++,
          newLine: undefined,
        })
      }
      for (let i = 0; i < part.additions; i++) {
        rows.push({
          kind: 'add',
          text: trimEol(fd.additionLines[part.additionLineIndex + i]),
          oldLine: undefined,
          newLine: newLine++,
        })
      }
    }
  }
  return rows
}
