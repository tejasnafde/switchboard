/**
 * Session-scoped notebook orchestration. On attach: discover the repo's
 * notebooks, ensure their mirrors, and watch both sides. Watcher events route
 * into the sync engine; agent mirror edits that land during a turn are
 * recorded per repo and drained by the registry as synthetic file.edited
 * events, which are the sole source of mirror diff cards (checkpoint
 * duplicates are filtered - see file-edit-filter.ts).
 *
 * Rooting: sessions may open a SUBDIRECTORY of a git repo, but checkpoint
 * diff relPaths are always toplevel-relative. The registry therefore resolves
 * the git toplevel and attach() keys everything by it, with the attach cwd
 * kept as an alias so checkpoint events (whose repoRoot is the session cwd)
 * still resolve to the right repo state.
 *
 * One watcher + sync engine per repo root, refcounted across the threads
 * attached to it.
 */
import { join, relative } from 'node:path'
import { mkdirSync } from 'node:fs'
import { watch } from 'chokidar'
import type { RuntimeEvent, RuntimeFileEditedEvent } from '@shared/provider-events'
import { createMainLogger } from '../logger'
import { discoverNotebooks } from './discover'
import { MIRROR_DIR, isMirrorRelPath } from './mirror-format'
import { NotebookSync } from './sync-engine'
import { buildNotebookSystemPrompt, type NotebookMirrorPair } from './system-prompt'

const log = createMainLogger('notebooks:manager')

export interface NotebookWatchHandle {
  /** Extend the watch set (notebooks are discovered after the watcher starts). */
  add(paths: string[]): void
  close(): void
}

export type NotebookWatchEvent = 'change' | 'unlink'

export type NotebookWatchFactory = (
  paths: string[],
  onEvent: (absPath: string, event: NotebookWatchEvent) => void
) => NotebookWatchHandle

/** Default: chokidar over the mirror tree + the notebook files themselves. */
const chokidarWatchFactory: NotebookWatchFactory = (paths, onEvent) => {
  const watcher = watch(paths, { persistent: true, ignoreInitial: true })
  watcher.on('add', (p) => onEvent(p, 'change'))
  watcher.on('change', (p) => onEvent(p, 'change'))
  watcher.on('unlink', (p) => onEvent(p, 'unlink'))
  watcher.on('error', (err) => log.warn('watcher error', { error: String(err) }))
  return {
    add: (more) => watcher.add(more),
    close: () => {
      void watcher.close()
    },
  }
}

interface PendingCard {
  changeKind: 'add' | 'modify'
  oldContent: string
  newContent: string
}

interface RepoState {
  root: string
  sync: NotebookSync
  watcher: NotebookWatchHandle
  refs: Set<string>
  /** Notebooks with a live mirror, by root-relative path. */
  mirrored: Set<string>
  pairs: NotebookMirrorPair[]
  /** Agent mirror edits awaiting a turn-end drain, coalesced per mirror. */
  pendingCards: Map<string, PendingCard>
}

interface ThreadState {
  repoRoot: string
  turnActive: boolean
  turnId: string
}

export class NotebookManager {
  private readonly repos = new Map<string, RepoState>()
  private readonly threads = new Map<string, ThreadState>()
  /** attach-cwd (and root itself) -> repo root, for checkpoint-event lookups. */
  private readonly rootAliases = new Map<string, string>()
  private readonly watch: NotebookWatchFactory
  private publish: (event: RuntimeEvent) => void = () => {}
  private turnSeq = 0

  constructor(deps: { watch?: NotebookWatchFactory } = {}) {
    this.watch = deps.watch ?? chokidarWatchFactory
  }

  /** Wire runtime-event publishing (invalid-edit errors surface in chat). */
  setPublisher(publish: (event: RuntimeEvent) => void): void {
    this.publish = publish
  }

  /**
   * Discover + mirror the repo's notebooks and start watching.
   * `repoRoot` is the git toplevel (resolved by the registry); `attachCwd`
   * is the session folder, kept as an alias for checkpoint-event lookups.
   */
  attach(threadId: string, attachCwd: string, repoRoot = attachCwd): NotebookMirrorPair[] {
    const repo = this.ensureRepo(repoRoot)
    repo.refs.add(threadId)
    this.rootAliases.set(attachCwd, repoRoot)
    this.rootAliases.set(repoRoot, repoRoot)

    for (const notebookRelPath of discoverNotebooks(repoRoot)) {
      if (repo.mirrored.has(notebookRelPath)) continue
      this.mirrorNotebook(repo, notebookRelPath)
    }

    this.threads.set(threadId, { repoRoot, turnActive: false, turnId: '' })
    log.info('attached', { threadId, repoRoot, notebooks: repo.pairs.length })
    return [...repo.pairs]
  }

  detach(threadId: string): void {
    const thread = this.threads.get(threadId)
    this.threads.delete(threadId)
    if (!thread) return
    const repo = this.repos.get(thread.repoRoot)
    if (!repo) return
    repo.refs.delete(threadId)
    if (repo.refs.size === 0) {
      repo.watcher.close()
      this.repos.delete(thread.repoRoot)
      for (const [alias, root] of this.rootAliases) {
        if (root === thread.repoRoot) this.rootAliases.delete(alias)
      }
      log.info('repo watch closed', { repoRoot: thread.repoRoot })
    }
  }

  beginTurn(threadId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    thread.turnActive = true
    thread.turnId = `nb${++this.turnSeq}`
  }

  /**
   * Synthetic mirror file.edited events for the turn. Pull-based sweep first:
   * an agent's final mirror edit can land after turn.completed processing but
   * before the fs watcher callback fires (fsevents latency), so the drain
   * checks every mirror itself instead of trusting the watcher. Pending cards
   * live per REPO and are claimed by the draining thread, so concurrent turns
   * on the same repo never see each other's cards duplicated.
   */
  drainTurnEdits(threadId: string): RuntimeFileEditedEvent[] {
    const thread = this.threads.get(threadId)
    if (!thread) return []
    const repo = this.repos.get(thread.repoRoot)
    if (!repo || !thread.turnActive) {
      thread.turnActive = false
      return []
    }

    for (const pair of repo.pairs) {
      try {
        this.onMirrorEvent(repo, pair.mirrorRelPath)
      } catch (err) {
        log.warn('drain sweep failed', { mirrorRelPath: pair.mirrorRelPath, error: String(err) })
      }
    }

    const events = [...repo.pendingCards.entries()].map(([mirrorRelPath, card]) => ({
      type: 'file.edited' as const,
      threadId,
      turnId: thread.turnId,
      fileEditId: `${thread.turnId}:${mirrorRelPath}`,
      repoRoot: repo.root,
      relPath: mirrorRelPath,
      changeKind: card.changeKind,
      oldContent: card.oldContent,
      newContent: card.newContent,
    }))
    repo.pendingCards.clear()
    thread.turnActive = false
    return events
  }

  /**
   * True when a checkpoint file.edited event is already covered by the mirror
   * system: mirror-path events (synthetics are their sole card source) and
   * .ipynb writes this repo's sync engine itself performed. A DIRECT .ipynb
   * edit (e.g. a provider without the redirect wired) is NOT explained, so
   * its raw diff card stays visible.
   */
  explainsFileEdit(event: RuntimeFileEditedEvent): boolean {
    if (isMirrorRelPath(event.relPath)) return true
    if (!event.relPath.endsWith('.ipynb')) return false
    const root = this.rootAliases.get(event.repoRoot)
    const repo = root ? this.repos.get(root) : undefined
    if (!repo || !repo.mirrored.has(event.relPath)) return false
    return repo.sync.explainsNotebookContent(event.relPath, event.newContent)
  }

  /** The resolved repo root for a thread (git toplevel), for path mapping. */
  rootFor(threadId: string): string | null {
    return this.threads.get(threadId)?.repoRoot ?? null
  }

  systemPromptFor(threadId: string): string {
    const thread = this.threads.get(threadId)
    const repo = thread ? this.repos.get(thread.repoRoot) : undefined
    return buildNotebookSystemPrompt(repo?.pairs ?? [])
  }

  /** Create the mirror for one notebook on demand (deny-redirect path). */
  ensureMirrorFor(threadId: string, notebookRelPath: string): void {
    const thread = this.threads.get(threadId)
    const repo = thread ? this.repos.get(thread.repoRoot) : undefined
    if (!repo || repo.mirrored.has(notebookRelPath)) return
    this.mirrorNotebook(repo, notebookRelPath)
  }

  private mirrorNotebook(repo: RepoState, notebookRelPath: string): void {
    try {
      const { mirrorRelPath } = repo.sync.ensureMirror(notebookRelPath)
      repo.mirrored.add(notebookRelPath)
      repo.pairs.push({ notebookRelPath, mirrorRelPath })
      repo.watcher.add([join(repo.root, notebookRelPath)])
    } catch (err) {
      log.warn('ensureMirror failed', { notebookRelPath, error: String(err) })
    }
  }

  private ensureRepo(repoRoot: string): RepoState {
    const existing = this.repos.get(repoRoot)
    if (existing) return existing

    const state: RepoState = {
      root: repoRoot,
      sync: new NotebookSync(repoRoot),
      watcher: { add: () => {}, close: () => {} },
      refs: new Set(),
      mirrored: new Set(),
      pairs: [],
      pendingCards: new Map(),
    }
    // Watch the mirror tree; mirrorNotebook() adds the notebook files. The
    // dir MUST exist before the watch starts - chokidar v4 silently ignores
    // paths that are missing at watch time (verified live; v3 waited for
    // them). Without this, agent mirror edits never sync.
    const mirrorDirAbs = join(repoRoot, MIRROR_DIR)
    mkdirSync(mirrorDirAbs, { recursive: true })
    state.watcher = this.watch([mirrorDirAbs], (absPath, event) => this.onWatchEvent(repoRoot, absPath, event))
    this.repos.set(repoRoot, state)
    return state
  }

  private onWatchEvent(repoRoot: string, absPath: string, event: NotebookWatchEvent): void {
    const repo = this.repos.get(repoRoot)
    if (!repo) return
    const relPath = relative(repoRoot, absPath).replace(/\\/g, '/')

    try {
      if (isMirrorRelPath(relPath)) {
        if (event === 'unlink') this.onMirrorUnlinked(repo, relPath)
        else this.onMirrorEvent(repo, relPath)
      } else if (relPath.endsWith('.ipynb') && event === 'change') {
        repo.sync.onNotebookChanged(relPath)
      }
    } catch (err) {
      log.warn('watch event failed', { relPath, error: String(err) })
    }
  }

  private turnActiveOn(repo: RepoState): boolean {
    for (const thread of this.threads.values()) {
      if (thread.repoRoot === repo.root && thread.turnActive) return true
    }
    return false
  }

  private onMirrorEvent(repo: RepoState, mirrorRelPath: string): void {
    const res = repo.sync.onMirrorChanged(mirrorRelPath)
    if (res.kind === 'invalid') {
      this.publishInvalidEdit(repo, mirrorRelPath, res.error)
      return
    }
    if (res.kind !== 'applied') return

    if (!repo.mirrored.has(res.notebookRelPath)) {
      repo.mirrored.add(res.notebookRelPath)
      repo.pairs.push({ notebookRelPath: res.notebookRelPath, mirrorRelPath })
      repo.watcher.add([join(repo.root, res.notebookRelPath)])
    }

    // Only agent turns produce diff cards; idle-time edits (user in an
    // editor, diff-card revert write-backs) sync silently.
    if (!this.turnActiveOn(repo)) return
    const prior = repo.pendingCards.get(mirrorRelPath)
    repo.pendingCards.set(mirrorRelPath, {
      changeKind: prior?.changeKind ?? (res.notebookCreated ? 'add' : 'modify'),
      oldContent: prior?.oldContent ?? res.oldMirror,
      newContent: res.newMirror,
    })
  }

  private onMirrorUnlinked(repo: RepoState, mirrorRelPath: string): void {
    const removed = repo.sync.onMirrorUnlinked(mirrorRelPath)
    if (!removed) return
    repo.mirrored.delete(removed.notebookRelPath)
    repo.pendingCards.delete(mirrorRelPath)
    const idx = repo.pairs.findIndex((p) => p.mirrorRelPath === mirrorRelPath)
    if (idx >= 0) repo.pairs.splice(idx, 1)
  }

  /** An agent's mirror edit failed validation - it got a successful Edit tool
   *  result, so without this the failure would be completely silent. */
  private publishInvalidEdit(repo: RepoState, mirrorRelPath: string, error: string): void {
    log.warn('mirror edit blocked', { mirrorRelPath, error })
    const attached = [...this.threads.entries()].filter(([, t]) => t.repoRoot === repo.root)
    const active = attached.filter(([, t]) => t.turnActive)
    for (const [threadId] of active.length > 0 ? active : attached) {
      this.publish({
        type: 'error',
        threadId,
        message: `Notebook mirror edit blocked - ${error}. The notebook (${mirrorRelPath}) was NOT updated; fix the mirror markers and retry.`,
      })
    }
  }
}

/**
 * Process-wide instance shared by the ProviderRegistry (attach/detach/turn
 * lifecycle + diff-card filtering) and the adapters (deny-redirect + system
 * prompt) - mirrors how policy.ts is a single shared module.
 */
export const notebookManager = new NotebookManager()
