import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NotebookManager, type NotebookWatchFactory, type NotebookWatchEvent } from '../../src/main/notebooks/manager'
import type { RuntimeEvent } from '../../src/shared/provider-events'

/**
 * Session-scoped orchestration: discover notebooks on attach, route watcher
 * events into the sync engine, and record agent mirror edits per repo as
 * synthetic file.edited events claimed by the draining thread.
 */

let repo: string
let manager: NotebookManager
let watchers: FakeWatcher[]
let published: RuntimeEvent[]

class FakeWatcher {
  closed = false
  readonly dirExistedAtWatchTime: boolean
  constructor(
    readonly paths: string[],
    private readonly onEvent: (absPath: string, event: NotebookWatchEvent) => void
  ) {
    this.dirExistedAtWatchTime = paths.every((p) => existsSync(p))
  }
  add(paths: string[]): void {
    this.paths.push(...paths)
  }
  emit(absPath: string, event: NotebookWatchEvent = 'change'): void {
    this.onEvent(absPath, event)
  }
  close(): void {
    this.closed = true
  }
}

const watchFactory: NotebookWatchFactory = (paths, onEvent) => {
  const w = new FakeWatcher(paths, onEvent)
  watchers.push(w)
  return w
}

const nbJson = (cells: unknown[]): string =>
  `${JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`

const codeCell = (id: string, source: string): Record<string, unknown> => ({
  id,
  cell_type: 'code',
  source: [source],
  metadata: {},
  outputs: [],
  execution_count: null,
})

const mirrorAbs = (): string => join(repo, '.switchboard/notebooks/nb.py')

const agentEditsMirror = (from: string, to: string): void => {
  writeFileSync(mirrorAbs(), readFileSync(mirrorAbs(), 'utf-8').replace(from, to))
  watchers[0].emit(mirrorAbs())
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sb-nbmanager-test-'))
  watchers = []
  published = []
  manager = new NotebookManager({ watch: watchFactory })
  manager.setPublisher((e) => published.push(e))
  writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 1')]))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('attach', () => {
  it('discovers notebooks, ensures mirrors, and reports the pairs', () => {
    const pairs = manager.attach('t1', repo)

    expect(pairs).toEqual([{ notebookRelPath: 'nb.ipynb', mirrorRelPath: '.switchboard/notebooks/nb.py' }])
    expect(readFileSync(mirrorAbs(), 'utf-8')).toContain('x = 1')
  })

  it('watches the mirror tree AND each discovered notebook file', () => {
    manager.attach('t1', repo)

    expect(watchers[0].paths).toContain(join(repo, '.switchboard/notebooks'))
    expect(watchers[0].paths).toContain(join(repo, 'nb.ipynb'))
  })

  it('creates the mirror dir BEFORE watching it (chokidar v4 ignores paths missing at watch time)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sb-nbmanager-empty-'))
    try {
      manager.attach('t2', empty)

      expect(existsSync(join(empty, '.switchboard/notebooks'))).toBe(true)
      expect(watchers.at(-1)?.dirExistedAtWatchTime).toBe(true)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('a second thread on the same repo reuses the discovery instead of re-mirroring', () => {
    manager.attach('t1', repo)
    const writes = watchers.length

    const pairs = manager.attach('t2', repo)

    expect(pairs).toHaveLength(1)
    expect(watchers).toHaveLength(writes) // no second watcher
  })

  it('exposes a system prompt covering the attached pairs', () => {
    manager.attach('t1', repo)
    expect(manager.systemPromptFor('t1')).toContain('nb.ipynb -> .switchboard/notebooks/nb.py')
    expect(manager.systemPromptFor('unknown-thread')).toBe('')
  })
})

describe('turn-scoped mirror edits', () => {
  beforeEach(() => {
    manager.attach('t1', repo)
  })

  it('records an agent mirror edit during a turn as a synthetic file.edited event', () => {
    manager.beginTurn('t1')
    agentEditsMirror('x = 1', 'x = 42')

    const events = manager.drainTurnEdits('t1')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'file.edited',
      threadId: 't1',
      repoRoot: repo,
      relPath: '.switchboard/notebooks/nb.py',
      changeKind: 'modify',
    })
    expect(events[0].oldContent).toContain('x = 1')
    expect(events[0].newContent).toContain('x = 42')
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toContain('x = 42')
  })

  it('coalesces re-edits of the same mirror within a turn (first old, last new)', () => {
    manager.beginTurn('t1')
    agentEditsMirror('x = 1', 'x = 2')
    agentEditsMirror('x = 2', 'x = 3')

    const events = manager.drainTurnEdits('t1')

    expect(events).toHaveLength(1)
    expect(events[0].oldContent).toContain('x = 1')
    expect(events[0].newContent).toContain('x = 3')
  })

  it('ignores mirror edits outside a turn (user edits sync silently)', () => {
    agentEditsMirror('x = 1', 'x = 7')

    manager.beginTurn('t1')
    expect(manager.drainTurnEdits('t1')).toEqual([])
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toContain('x = 7')
  })

  it('drain empties the pending set', () => {
    manager.beginTurn('t1')
    agentEditsMirror('x = 1', 'x = 9')
    manager.drainTurnEdits('t1')

    manager.beginTurn('t1')
    expect(manager.drainTurnEdits('t1')).toEqual([])
  })

  it('drain catches a mirror edit whose watcher event has NOT arrived yet (fsevents race)', () => {
    manager.beginTurn('t1')
    writeFileSync(mirrorAbs(), readFileSync(mirrorAbs(), 'utf-8').replace('x = 1', 'x = 42'))

    const events = manager.drainTurnEdits('t1')

    expect(events).toHaveLength(1)
    expect(events[0].newContent).toContain('x = 42')
    expect(readFileSync(join(repo, 'nb.ipynb'), 'utf-8')).toContain('x = 42')
  })

  it('a card is claimed by ONE draining thread, never duplicated across concurrent turns', () => {
    manager.attach('t2', repo)
    manager.beginTurn('t1')
    manager.beginTurn('t2')
    agentEditsMirror('x = 1', 'x = 5')

    const first = manager.drainTurnEdits('t1')
    const second = manager.drainTurnEdits('t2')

    expect(first).toHaveLength(1)
    expect(first[0].threadId).toBe('t1')
    expect(second).toEqual([])
  })

  it('publishes an error event when an agent mirror edit fails validation', () => {
    manager.beginTurn('t1')
    writeFileSync(mirrorAbs(), '# %% [cellbridge_id=rogue] [type=code] [lang=python]\nprint("rewrite")\n')
    watchers[0].emit(mirrorAbs())

    const errors = published.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ threadId: 't1' })
    expect((errors[0] as { message: string }).message).toMatch(/mirror edit blocked/i)
  })
})

describe('notebook-side routing, unlink and detach', () => {
  it('routes .ipynb change events into a mirror regeneration', () => {
    manager.attach('t1', repo)
    writeFileSync(join(repo, 'nb.ipynb'), nbJson([codeCell('a', 'x = 99')]))
    watchers[0].emit(join(repo, 'nb.ipynb'))

    expect(readFileSync(mirrorAbs(), 'utf-8')).toContain('x = 99')
  })

  it('a notebook authored via a new mirror gets its .ipynb watched too', () => {
    manager.attach('t1', repo)
    const freshMirror = join(repo, '.switchboard/notebooks/fresh.py')
    writeFileSync(freshMirror, '# %% [cellbridge_id=n1] [type=code] [lang=python]\nprint("hi")\n')
    watchers[0].emit(freshMirror)

    expect(existsSync(join(repo, 'fresh.ipynb'))).toBe(true)
    expect(watchers[0].paths).toContain(join(repo, 'fresh.ipynb'))
  })

  it('deleting the mirror of an engine-created notebook removes the notebook (card reject)', () => {
    manager.attach('t1', repo)
    const freshMirror = join(repo, '.switchboard/notebooks/fresh.py')
    writeFileSync(freshMirror, '# %% [cellbridge_id=n1] [type=code] [lang=python]\nprint("hi")\n')
    watchers[0].emit(freshMirror)
    expect(existsSync(join(repo, 'fresh.ipynb'))).toBe(true)

    rmSync(freshMirror)
    watchers[0].emit(freshMirror, 'unlink')

    expect(existsSync(join(repo, 'fresh.ipynb'))).toBe(false)
    expect(manager.systemPromptFor('t1')).not.toContain('fresh.ipynb')
  })

  it('detach closes the watcher and forgets the thread', () => {
    manager.attach('t1', repo)
    manager.detach('t1')

    expect(watchers[0].closed).toBe(true)
    expect(manager.systemPromptFor('t1')).toBe('')
    expect(manager.rootFor('t1')).toBeNull()
  })
})
