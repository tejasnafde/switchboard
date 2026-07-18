import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NotebookSync } from '../../src/main/notebooks/sync-engine'

/**
 * Stateful mirror sync for one repo root. Watching is wired separately
 * (thin chokidar layer) - these tests drive the engine's event methods
 * directly against a real temp filesystem.
 */

let repo: string
let sync: NotebookSync

const nbJson = (cells: unknown[]): string =>
  `${JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`

const codeCell = (id: string, source: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  cell_type: 'code',
  source: [source],
  metadata: {},
  outputs: [],
  execution_count: null,
  ...extra,
})

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sb-nbsync-test-'))
  sync = new NotebookSync(repo)
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('ensureMirror', () => {
  it('writes a mirror under .switchboard/notebooks preserving the tree', () => {
    mkdirSync(join(repo, 'reports'))
    writeFileSync(join(repo, 'reports/q3.ipynb'), nbJson([codeCell('a', 'x = 1')]))

    const res = sync.ensureMirror('reports/q3.ipynb')

    expect(res.mirrorRelPath).toBe('.switchboard/notebooks/reports/q3.py')
    const mirror = readFileSync(join(repo, res.mirrorRelPath), 'utf-8')
    expect(mirror).toContain('# %% [cellbridge_id=a] [type=code] [lang=python]')
    expect(mirror).toContain('x = 1')
  })

  it('persists freshly assigned cell ids back into the notebook', () => {
    writeFileSync(
      join(repo, 'nb.ipynb'),
      nbJson([{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }])
    )

    sync.ensureMirror('nb.ipynb')

    const doc = JSON.parse(readFileSync(join(repo, 'nb.ipynb'), 'utf-8'))
    expect(typeof doc.cells[0].id).toBe('string')
    expect(doc.cells[0].id.length).toBeGreaterThan(0)
  })

  it('is idempotent - a second call does not rewrite the notebook', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    const before = readFileSync(join(repo, 'nb.ipynb'), 'utf-8')

    sync.ensureMirror('nb.ipynb')

    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toBe(before)
    expect(existsSync(join(repo, '.switchboard/notebooks/nb.py'))).toBe(true)
  })
})

describe('onNotebookChanged', () => {
  it('regenerates the mirror after a user edit to the notebook', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')

    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 99')]))
    const res = sync.onNotebookChanged('nb.ipynb')

    expect(res.kind).toBe('synced')
    expect(readFileSync(join(repo, '.switchboard/notebooks/nb.py'), 'utf-8')).toContain('x = 99')
  })

  it('ignores the echo of its own notebook write', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    writeFileSync(join(repo, '.switchboard/notebooks/nb.py'), readFileSync(join(repo, '.switchboard/notebooks/nb.py'), 'utf-8').replace('x = 1', 'x = 2'))
    sync.onMirrorChanged('.switchboard/notebooks/nb.py') // writes nb.ipynb -> own content on disk

    const res = sync.onNotebookChanged('nb.ipynb')

    expect(res.kind).toBe('unchanged')
  })
})

describe('onMirrorChanged', () => {
  it('applies an agent edit to the notebook and reports old/new mirror content', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    const mirrorAbs = join(repo, '.switchboard/notebooks/nb.py')
    const before = readFileSync(mirrorAbs, 'utf-8')
    writeFileSync(mirrorAbs, before.replace('x = 1', 'x = 42'))

    const res = sync.onMirrorChanged('.switchboard/notebooks/nb.py')

    expect(res.kind).toBe('applied')
    if (res.kind !== 'applied') return
    expect(res.notebookRelPath).toBe('nb.ipynb')
    expect(res.oldMirror).toBe(before)
    expect(res.newMirror).toContain('x = 42')
    const doc = JSON.parse(readFileSync(join(repo, 'nb.ipynb'), 'utf-8'))
    expect(doc.cells[0].source).toEqual(['x = 42'])
  })

  it('re-attaches outputs from the notebook as it is on disk NOW (stale-snapshot fix)', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    // User executes the cell AFTER the mirror was created - outputs land on disk
    const executed = codeCell('a', 'x = 1', {
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['ran\n'] }],
      execution_count: 7,
    })
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([executed]))
    const mirrorAbs = join(repo, '.switchboard/notebooks/nb.py')
    writeFileSync(mirrorAbs, readFileSync(mirrorAbs, 'utf-8').replace('x = 1', 'x = 42'))

    const res = sync.onMirrorChanged('.switchboard/notebooks/nb.py')

    expect(res.kind).toBe('applied')
    const doc = JSON.parse(readFileSync(join(repo, 'nb.ipynb'), 'utf-8'))
    expect(doc.cells[0].outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: ['ran\n'] }])
    expect(doc.cells[0].execution_count).toBe(7)
  })

  it('blocks an invalid mirror (total rewrite) and leaves the notebook untouched', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    const notebookBefore = readFileSync(join(repo, 'nb.ipynb'), 'utf-8')
    writeFileSync(
      join(repo, '.switchboard/notebooks/nb.py'),
      '# %% [cellbridge_id=rogue] [type=code] [lang=python]\nprint("rewrite")\n'
    )

    const res = sync.onMirrorChanged('.switchboard/notebooks/nb.py')

    expect(res.kind).toBe('invalid')
    if (res.kind !== 'invalid') return
    expect(res.error).toMatch(/no original cell ids survived/i)
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toBe(notebookBefore)
  })

  it('treats its own mirror write (and any repeat event for it) as unchanged', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb') // wrote the mirror -> own content on disk

    expect(sync.onMirrorChanged('.switchboard/notebooks/nb.py').kind).toBe('unchanged')
    expect(sync.onMirrorChanged('.switchboard/notebooks/nb.py').kind).toBe('unchanged')
  })
})

describe('ensureMirror against an existing mirror', () => {
  const mirrorPath = (): string => join(repo, '.switchboard/notebooks/nb.py')

  it('skips the write when the mirror already matches (no mtime churn)', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    const stampBefore = statSync(mirrorPath()).mtimeMs

    new NotebookSync(repo).ensureMirror('nb.ipynb') // fresh engine, same content

    expect(statSync(mirrorPath()).mtimeMs).toBe(stampBefore)
  })

  it('applies (not clobbers) a foreign mirror edit that is newer than the notebook', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    // Agent edited the mirror; the watcher event was missed; a new session attaches.
    writeFileSync(mirrorPath(), readFileSync(mirrorPath(), 'utf-8').replace('x = 1', 'x = 42'))
    const future = new Date(Date.now() + 5000)
    utimesSync(mirrorPath(), future, future)

    const res = new NotebookSync(repo).ensureMirror('nb.ipynb')

    expect(res.pendingEdit?.kind).toBe('applied')
    expect(readFileSync(mirrorPath(), 'utf-8')).toContain('x = 42')
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toContain('x = 42')
  })

  it('regenerates a stale mirror when the notebook is newer', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    writeFileSync(mirrorPath(), readFileSync(mirrorPath(), 'utf-8').replace('x = 1', 'x = old'))
    // Notebook edited later (e.g. in Jupyter overnight) - notebook wins.
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 99')]))
    const future = new Date(Date.now() + 5000)
    utimesSync(join(repo, 'nb.ipynb'), future, future)

    new NotebookSync(repo).ensureMirror('nb.ipynb')

    expect(readFileSync(mirrorPath(), 'utf-8')).toContain('x = 99')
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toContain('x = 99')
  })
})

describe('onMirrorUnlinked', () => {
  it('deletes a notebook this engine materialized when its mirror is deleted', () => {
    mkdirSync(join(repo, '.switchboard/notebooks'), { recursive: true })
    writeFileSync(
      join(repo, '.switchboard/notebooks/fresh.py'),
      '# %% [cellbridge_id=n1] [type=code] [lang=python]\nprint("hi")\n'
    )
    sync.onMirrorChanged('.switchboard/notebooks/fresh.py')
    expect(existsSync(join(repo, 'fresh.ipynb'))).toBe(true)
    rmSync(join(repo, '.switchboard/notebooks/fresh.py'))

    const res = sync.onMirrorUnlinked('.switchboard/notebooks/fresh.py')

    expect(res?.notebookRelPath).toBe('fresh.ipynb')
    expect(existsSync(join(repo, 'fresh.ipynb'))).toBe(false)
  })

  it('never deletes a pre-existing notebook', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    rmSync(join(repo, '.switchboard/notebooks/nb.py'))

    const res = sync.onMirrorUnlinked('.switchboard/notebooks/nb.py')

    expect(res).toBeNull()
    expect(existsSync(join(repo, 'nb.ipynb'))).toBe(true)
  })
})

describe('explainsNotebookContent', () => {
  it('recognizes notebook content this engine wrote, and nothing else', () => {
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
    sync.ensureMirror('nb.ipynb')
    writeFileSync(join(repo, '.switchboard/notebooks/nb.py'), readFileSync(join(repo, '.switchboard/notebooks/nb.py'), 'utf-8').replace('x = 1', 'x = 2'))
    sync.onMirrorChanged('.switchboard/notebooks/nb.py')
    const written = readFileSync(join(repo, 'nb.ipynb'), 'utf-8')

    expect(sync.explainsNotebookContent('nb.ipynb', written)).toBe(true)
    expect(sync.explainsNotebookContent('nb.ipynb', written.replace('x = 2', 'x = 3'))).toBe(false)
  })
})

describe('onMirrorChanged for a brand-new notebook', () => {
  it('creates the .ipynb from a freshly written mirror (agent authors a new notebook)', () => {
    mkdirSync(join(repo, '.switchboard/notebooks'), { recursive: true })
    writeFileSync(
      join(repo, '.switchboard/notebooks/fresh.py'),
      '# %% [cellbridge_id=n1] [type=code] [lang=python]\nprint("hi")\n'
    )

    const res = sync.onMirrorChanged('.switchboard/notebooks/fresh.py')

    expect(res.kind).toBe('applied')
    const doc = JSON.parse(readFileSync(join(repo, 'fresh.ipynb'), 'utf-8'))
    expect(doc.nbformat).toBe(4)
    expect(doc.nbformat_minor).toBeGreaterThanOrEqual(5)
    expect(doc.cells).toHaveLength(1)
    expect(doc.cells[0].id).toBe('n1')
    expect(doc.cells[0].source).toEqual(['print("hi")'])
  })
})
