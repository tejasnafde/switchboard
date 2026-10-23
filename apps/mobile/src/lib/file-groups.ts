/**
 * A turn's changed files fold behind one "Changed N files" row, collapsed by
 * default like the desktop's `chat.showFileDiffs` off, and expanded per turn
 * on this device only. A turn is everything between two user rows; the group
 * sits where the turn's first file row was. Same rule as native Android's
 * ThreadFileGroups.kt.
 */
import { compactFileDiff, type CompactFileDiff } from '@shared/compact-file-diff'
import type { FeedItem } from '../stores/chat'

type FileEdit = Extract<FeedItem, { kind: 'fileEdit' }>

export interface FileGroupRow {
  kind: 'fileGroup'
  id: string
  label: string
  added: number
  removed: number
  expanded: boolean
}

export type FeedRow = FeedItem | FileGroupRow

export function changedFilesLabel(count: number): string {
  return `Changed ${count} file${count === 1 ? '' : 's'}`
}

const diffs = new WeakMap<FileEdit, CompactFileDiff>()

/** The row's read-only diff, computed once per item: the group row and the file row both read it. */
export function fileEditDiff(item: FileEdit): CompactFileDiff {
  let diff = diffs.get(item)
  if (!diff) {
    diff = compactFileDiff(item.oldContent, item.newContent)
    diffs.set(item, diff)
  }
  return diff
}

export function collapseFileEdits(items: readonly FeedItem[], expanded: ReadonlySet<string>): FeedRow[] {
  const rows: FeedRow[] = []
  let turn: FeedItem[] = []
  const flush = () => {
    const files = turn.filter((item): item is FileEdit => item.kind === 'fileEdit')
    for (const item of turn) {
      if (item.kind !== 'fileEdit') rows.push(item)
      else if (item === files[0]) {
        const id = `files:${item.id}`
        const fileDiffs = files.map(fileEditDiff)
        const open = expanded.has(id)
        rows.push({
          kind: 'fileGroup',
          id,
          label: changedFilesLabel(files.length),
          added: fileDiffs.reduce((sum, c) => sum + c.addedLines, 0),
          removed: fileDiffs.reduce((sum, c) => sum + c.removedLines, 0),
          expanded: open,
        })
        if (open) rows.push(...files)
      }
    }
    turn = []
  }
  for (const item of items) {
    if (item.kind === 'user') flush()
    turn.push(item)
  }
  flush()
  return rows
}
