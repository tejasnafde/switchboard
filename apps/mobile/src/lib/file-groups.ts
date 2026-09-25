/**
 * A turn's changed files fold behind one "Changed N files" row, collapsed by
 * default like the desktop's `chat.showFileDiffs` off, and expanded per turn
 * on this device only. A turn is everything between two user rows; the group
 * sits where the turn's first file row was. Same rule as native Android's
 * ThreadFileGroups.kt.
 */
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

/** Line counts a file row shows; whole-file, since the phone has no hunks. */
export function fileEditCounts(item: FileEdit): { added: number; removed: number } {
  const oldLines = item.oldContent ? item.oldContent.split('\n').length : 0
  const newLines = item.newContent ? item.newContent.split('\n').length : 0
  return {
    added: item.changeKind === 'delete' ? 0 : item.changeKind === 'add' ? newLines : Math.max(0, newLines - oldLines),
    removed: item.changeKind === 'add' ? 0 : item.changeKind === 'delete' ? oldLines : Math.max(0, oldLines - newLines),
  }
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
        const counts = files.map(fileEditCounts)
        const open = expanded.has(id)
        rows.push({
          kind: 'fileGroup',
          id,
          label: changedFilesLabel(files.length),
          added: counts.reduce((sum, c) => sum + c.added, 0),
          removed: counts.reduce((sum, c) => sum + c.removed, 0),
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
