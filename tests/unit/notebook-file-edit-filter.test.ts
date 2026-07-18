import { describe, it, expect } from 'vitest'
import type { RuntimeFileEditedEvent } from '../../src/shared/provider-events'
import { filterNotebookFileEdits } from '../../src/main/notebooks/file-edit-filter'
import { NotebookManager, type NotebookWatchFactory } from '../../src/main/notebooks/manager'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Diff-card hygiene: mirror-path events and engine-written .ipynb content are
 * covered by synthetic mirror cards; everything else (including DIRECT .ipynb
 * edits that bypassed the mirror) must stay visible.
 */

const ev = (relPath: string, overrides: Partial<RuntimeFileEditedEvent> = {}): RuntimeFileEditedEvent => ({
  type: 'file.edited',
  threadId: 't1',
  turnId: '1',
  fileEditId: `1:${relPath}`,
  repoRoot: '/repo',
  relPath,
  changeKind: 'modify',
  oldContent: 'old',
  newContent: 'new',
  ...overrides,
})

describe('filterNotebookFileEdits', () => {
  it('drops events the predicate explains and keeps the rest', () => {
    const out = filterNotebookFileEdits([ev('a.ipynb'), ev('src/app.ts')], (e) => e.relPath === 'a.ipynb')
    expect(out.map((e) => e.relPath)).toEqual(['src/app.ts'])
  })
})

describe('NotebookManager.explainsFileEdit', () => {
  const noWatch: NotebookWatchFactory = () => ({ add: () => {}, close: () => {} })

  const nbJson = JSON.stringify(
    {
      cells: [{ id: 'a', cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1
  ) + '\n'

  it('explains mirror-path events, engine-written .ipynb content, and nothing else', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sb-nbfilter-test-'))
    try {
      writeFileSync(join(repo, 'nb.ipynb'), nbJson)
      const manager = new NotebookManager({ watch: noWatch })
      manager.attach('t1', repo)

      // Mirror-path events: always covered by synthetics.
      expect(manager.explainsFileEdit(ev('.switchboard/notebooks/nb.py', { repoRoot: repo }))).toBe(true)

      // Engine-written .ipynb content: covered (agent edited the mirror).
      writeFileSync(
        join(repo, '.switchboard/notebooks/nb.py'),
        readFileSync(join(repo, '.switchboard/notebooks/nb.py'), 'utf-8').replace('x = 1', 'x = 2')
      )
      manager.beginTurn('t1')
      manager.drainTurnEdits('t1') // sweep applies the mirror edit
      const engineWritten = readFileSync(join(repo, 'nb.ipynb'), 'utf-8')
      expect(manager.explainsFileEdit(ev('nb.ipynb', { repoRoot: repo, newContent: engineWritten }))).toBe(true)

      // DIRECT .ipynb edit (provider bypassed the mirror): NOT explained.
      expect(manager.explainsFileEdit(ev('nb.ipynb', { repoRoot: repo, newContent: '{"cells": []}' }))).toBe(false)

      // Non-notebook files and unknown repos: never explained.
      expect(manager.explainsFileEdit(ev('src/app.ts', { repoRoot: repo }))).toBe(false)
      expect(manager.explainsFileEdit(ev('nb.ipynb', { repoRoot: '/elsewhere' }))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves the attach cwd as an alias when the repo root differs (subdir sessions)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-nbfilter-root-'))
    try {
      writeFileSync(join(root, 'nb.ipynb'), nbJson)
      const manager = new NotebookManager({ watch: noWatch })
      // Session opened at <root>/analysis but rooted at the git toplevel.
      manager.attach('t1', join(root, 'analysis'), root)

      // Checkpoint events carry repoRoot = session cwd + toplevel-relative paths.
      expect(manager.explainsFileEdit(ev('.switchboard/notebooks/nb.py', { repoRoot: join(root, 'analysis') }))).toBe(true)
      expect(manager.rootFor('t1')).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
