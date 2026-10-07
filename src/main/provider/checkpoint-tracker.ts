/**
 * Provider-agnostic turn lifecycle for the in-chat diff-review feature.
 *
 * Bridges the git checkpoint primitives (`../git/checkpoint`) to the runtime
 * event stream: snapshot the working tree when a turn starts, diff it against
 * the working tree when the turn completes, and emit one `file.edited` event
 * per changed file. Because git is the source of truth, this behaves
 * identically for every provider.
 *
 * Held by the ProviderRegistry, which calls `beginTurn` before dispatching a
 * turn to the adapter and `finishTurn` when it sees a `turn.completed` event.
 *
 * The checkout is shared (other chats, the user's IDE), so a changed file is
 * only this turn's to revert when one of this chat's edit tools wrote it
 * (`noteToolStarted` / `noteToolCompleted`). Every other card ships with
 * `noRevert: 'outside'`.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { RuntimeFileEditedEvent } from '@shared/provider-events'
import {
  createCheckpoint as realCreateCheckpoint,
  diffCheckpoint as realDiffCheckpoint,
  isGitRepo as realIsGitRepo,
} from '../git/checkpoint'
import { createMainLogger } from '../logger'
import { absolutePaths, agentWrittenPaths, pathKey } from './agent-written-paths'

const log = createMainLogger('provider:checkpoint-tracker')

export interface StoredTurnCheckpoint {
  turnId: string
  tree: string
  repoRoot: string
  /** Absolute paths this chat's edit tools wrote during the turn. */
  written: string[]
}

/** Keeps a running turn's baseline across a restart. */
export interface TurnCheckpointStore {
  save(threadId: string, checkpoint: StoredTurnCheckpoint): void
  remove(threadId: string): void
  /** A baseline an earlier process left behind (it stopped mid-turn), removed as it is returned. */
  takeEarlier(threadId: string): StoredTurnCheckpoint | null
}

export interface CheckpointTrackerDeps {
  createCheckpoint: typeof realCreateCheckpoint
  diffCheckpoint: typeof realDiffCheckpoint
  isGitRepo: typeof realIsGitRepo
  store: TurnCheckpointStore | null
}

interface PendingCheckpoint {
  turnId: string
  tree: string
  repoRoot: string
  written: Set<string>
  /**
   * False for the end-of-turn tree kept for a queued message that may start
   * next: it becomes that turn's baseline only once the turn starts.
   */
  active: boolean
}

export class CheckpointTracker {
  private pending = new Map<string, PendingCheckpoint>()
  /** A queued message started (or is about to) after the running turn: it takes that turn's end tree. */
  private startsNext = new Set<string>()
  /** Paths named by tool calls that have started but not completed, by thread then tool id. */
  private toolPaths = new Map<string, Map<string, string[]>>()
  private deps: CheckpointTrackerDeps
  // Counter (not the clock) so same-millisecond turns can't collide on turnId.
  private seq = 0
  // The cards are stored by fileEditId, so a restart must not reuse turn 1.
  private readonly launch = randomUUID().slice(0, 8)

  constructor(deps: Partial<CheckpointTrackerDeps> = {}) {
    this.deps = {
      createCheckpoint: realCreateCheckpoint,
      diffCheckpoint: realDiffCheckpoint,
      isGitRepo: realIsGitRepo,
      store: null,
      ...deps,
    }
  }

  /**
   * Snapshot the working tree before the agent runs. No-op (and drops any
   * stale pending entry) for non-git directories or on checkpoint failure.
   * `midTurn` (a steer, or a message queued behind the running turn) keeps
   * the running turn's baseline, or the edits made before it would get no card.
   */
  async beginTurn(threadId: string, repoRoot: string, midTurn = false): Promise<void> {
    if (midTurn && this.keepBaseline(threadId)) return
    try {
      if (!(await this.deps.isGitRepo(repoRoot))) {
        this.drop(threadId)
        return
      }
      const res = await this.deps.createCheckpoint(repoRoot)
      if (!res.ok) {
        log.warn('start checkpoint failed', { threadId, error: res.error })
        this.drop(threadId)
        return
      }
      this.set(threadId, { turnId: this.nextTurnId(), tree: res.tree, repoRoot, written: new Set(), active: true })
    } catch (err) {
      log.warn('beginTurn failed', { threadId, err })
      this.drop(threadId)
    }
  }

  /**
   * A queued message started its own turn: it runs from the tree the previous
   * turn ended on. The start can be reported before that turn's end, or while
   * its diff runs, so it may only be noted here.
   */
  startQueuedTurn(threadId: string): void {
    const entry = this.pending.get(threadId)
    if (entry && !entry.active) this.keepBaseline(threadId)
    else this.startsNext.add(threadId)
  }

  noteToolStarted(threadId: string, toolId: string, toolName: string, input: unknown): void {
    const entry = this.pending.get(threadId)
    if (!entry) return
    const paths = agentWrittenPaths(toolName, input, entry.repoRoot)
    if (paths.length === 0) return
    let byTool = this.toolPaths.get(threadId)
    if (!byTool) this.toolPaths.set(threadId, (byTool = new Map()))
    byTool.set(toolId, [...(byTool.get(toolId) ?? []), ...paths])
  }

  /** Paths count as the agent's once the tool completes, not when it is asked for (it may be denied). */
  noteToolCompleted(threadId: string, toolId: string, writtenPaths: readonly string[] = []): void {
    const started = this.toolPaths.get(threadId)?.get(toolId) ?? []
    this.toolPaths.get(threadId)?.delete(toolId)
    const entry = this.pending.get(threadId)
    if (!entry?.active) return
    const paths = [...started, ...absolutePaths(writtenPaths, entry.repoRoot)]
    if (paths.length === 0) return
    for (const p of paths) entry.written.add(p)
    this.persist(threadId, entry)
  }

  /**
   * Diff the start checkpoint against the current working tree and return one
   * `file.edited` event per changed file. Consumes the pending checkpoint, so
   * a repeat call returns `[]`.
   */
  async finishTurn(threadId: string): Promise<RuntimeFileEditedEvent[]> {
    const entry = this.pending.get(threadId)
    if (!entry?.active) return []
    this.pending.delete(threadId)
    this.toolPaths.delete(threadId)
    try {
      const res = await this.deps.diffCheckpoint(entry.repoRoot, entry.tree)
      if (!res.ok) {
        log.warn('end checkpoint diff failed', { threadId, error: res.error })
        return []
      }
      // A turn begun while this diff ran owns the slot now.
      if (!this.pending.has(threadId) && res.endTree) {
        this.pending.set(threadId, {
          turnId: this.nextTurnId(), tree: res.endTree, repoRoot: entry.repoRoot, written: new Set(), active: false,
        })
        if (this.startsNext.delete(threadId)) this.keepBaseline(threadId)
      }
      return res.files.map((f) => {
        const noRevert = f.noRevert ?? (entry.written.has(pathKey(resolve(entry.repoRoot, f.relPath))) ? undefined : 'outside')
        return {
          type: 'file.edited',
          threadId,
          turnId: entry.turnId,
          fileEditId: `${entry.turnId}:${f.relPath}`,
          repoRoot: entry.repoRoot,
          relPath: f.relPath,
          changeKind: f.changeKind,
          oldContent: f.oldContent,
          newContent: f.newContent,
          ...(noRevert ? { noRevert } : {}),
        }
      })
    } catch (err) {
      log.warn('finishTurn failed', { threadId, err })
      return []
    } finally {
      if (!this.pending.get(threadId)?.active) this.unpersist(threadId)
    }
  }

  /**
   * Load the baseline of a turn an earlier process was running when it
   * stopped, so `finishTurn` can still show what that turn changed.
   */
  restoreEarlier(threadId: string): boolean {
    if (this.pending.get(threadId)?.active) return false
    let stored: StoredTurnCheckpoint | null
    try {
      stored = this.deps.store?.takeEarlier(threadId) ?? null
    } catch (err) {
      log.warn('could not read a stored checkpoint', { threadId, err })
      return false
    }
    if (!stored) return false
    // Normalised again on restore, so a baseline stored by an older build still matches.
    const entry = { ...stored, written: new Set(stored.written.map((p) => pathKey(p))), active: true }
    this.pending.set(threadId, entry)
    this.persist(threadId, entry)
    return true
  }

  /** Drop any pending checkpoint for a thread (e.g. on session stop). */
  clear(threadId: string): void {
    this.drop(threadId)
  }

  /** Keep or activate the existing baseline. False when there is none to keep. */
  private keepBaseline(threadId: string): boolean {
    const entry = this.pending.get(threadId)
    if (entry) {
      if (!entry.active) {
        entry.active = true
        this.persist(threadId, entry)
      }
      return true
    }
    return false
  }

  private nextTurnId(): string {
    return `${this.launch}-${++this.seq}`
  }

  private set(threadId: string, entry: PendingCheckpoint): void {
    this.pending.set(threadId, entry)
    this.toolPaths.delete(threadId)
    this.startsNext.delete(threadId)
    this.persist(threadId, entry)
  }

  private drop(threadId: string): void {
    this.pending.delete(threadId)
    this.toolPaths.delete(threadId)
    this.startsNext.delete(threadId)
    this.unpersist(threadId)
  }

  private persist(threadId: string, entry: PendingCheckpoint): void {
    try {
      this.deps.store?.save(threadId, { turnId: entry.turnId, tree: entry.tree, repoRoot: entry.repoRoot, written: [...entry.written] })
    } catch (err) {
      log.warn('could not store the turn checkpoint', { threadId, err })
    }
  }

  private unpersist(threadId: string): void {
    try {
      this.deps.store?.remove(threadId)
    } catch (err) {
      log.warn('could not remove the stored turn checkpoint', { threadId, err })
    }
  }
}
