import { describe, expect, it } from 'vitest'
import { changedFilesLabel, collapseFileEdits } from '../../apps/mobile/src/lib/file-groups'
import type { FeedItem } from '../../apps/mobile/src/stores/chat'

const file = (id: string, oldContent: string, newContent: string): FeedItem =>
  ({ kind: 'fileEdit', id, relPath: `${id}.ts`, changeKind: oldContent ? 'modify' : 'add', oldContent, newContent })
const user = (id: string): FeedItem => ({ kind: 'user', id, text: id }) as FeedItem
const text = (id: string): FeedItem => ({ kind: 'text', id, text: id, stream: 'assistant' }) as FeedItem

const items: FeedItem[] = [
  user('u1'), text('t1'), file('f-a', 'x', 'y'), file('f-b', '', 'one\ntwo'),
  user('u2'), file('f-c', 'x', 'z'), text('t2'),
]

describe('phone file groups', () => {
  it('folds each turn behind one collapsed row where its first file was', () => {
    const rows = collapseFileEdits(items, new Set())
    expect(rows.map((r) => r.id)).toEqual(['u1', 't1', 'files:f-a', 'u2', 'files:f-c', 't2'])
    expect(rows[2]).toMatchObject({ kind: 'fileGroup', label: 'Changed 2 files', added: 2, expanded: false })
    expect(rows[4]).toMatchObject({ label: 'Changed 1 file' })
  })

  it('expands only the tapped turn', () => {
    const rows = collapseFileEdits(items, new Set(['files:f-a']))
    expect(rows.map((r) => r.id)).toEqual(['u1', 't1', 'files:f-a', 'f-a', 'f-b', 'u2', 'files:f-c', 't2'])
  })

  it('leaves a feed without file edits alone', () => {
    const plain = items.filter((i) => i.kind !== 'fileEdit')
    expect(collapseFileEdits(plain, new Set())).toEqual(plain)
  })

  it('counts files in the label', () => {
    expect(changedFilesLabel(1)).toBe('Changed 1 file')
    expect(changedFilesLabel(8)).toBe('Changed 8 files')
  })
})
