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
 */
import type { RuntimeFileEditedEvent } from '@shared/provider-events'
import {
  createCheckpoint as realCreateCheckpoint,
  diffCheckpoint as realDiffCheckpoint,
  isGitRepo as realIsGitRepo,
} from '../git/checkpoint'
import { createMainLogger } from '../logger'

const log = createMainLogger('provider:checkpoint-tracker')

export interface CheckpointTrackerDeps {
  createCheckpoint: typeof realCreateCheckpoint
  diffCheckpoint: typeof realDiffCheckpoint
  isGitRepo: typeof realIsGitRepo
  now: () => number
}

interface PendingCheckpoint {
  turnId: string
  tree: string
  repoRoot: string
}

export class CheckpointTracker {
  private pending = new Map<string, PendingCheckpoint>()
  private deps: CheckpointTrackerDeps

  constructor(deps: Partial<CheckpointTrackerDeps> = {}) {
    this.deps = {
      createCheckpoint: realCreateCheckpoint,
      diffCheckpoint: realDiffCheckpoint,
      isGitRepo: realIsGitRepo,
      now: () => Date.now(),
      ...deps,
    }
  }

  /**
   * Snapshot the working tree before the agent runs. No-op (and drops any
   * stale pending entry) for non-git directories or on checkpoint failure.
   */
  async beginTurn(threadId: string, repoRoot: string): Promise<void> {
    try {
      if (!(await this.deps.isGitRepo(repoRoot))) {
        this.pending.delete(threadId)
        return
      }
      const res = await this.deps.createCheckpoint(repoRoot)
      if (!res.ok) {
        log.warn('start checkpoint failed', { threadId, error: res.error })
        this.pending.delete(threadId)
        return
      }
      this.pending.set(threadId, { turnId: String(this.deps.now()), tree: res.tree, repoRoot })
    } catch (err) {
      log.warn('beginTurn failed', { threadId, err })
      this.pending.delete(threadId)
    }
  }

  /**
   * Diff the start checkpoint against the current working tree and return one
   * `file.edited` event per changed file. Consumes the pending checkpoint, so
   * a repeat call returns `[]`.
   */
  async finishTurn(threadId: string): Promise<RuntimeFileEditedEvent[]> {
    const entry = this.pending.get(threadId)
    if (!entry) return []
    this.pending.delete(threadId)
    try {
      const res = await this.deps.diffCheckpoint(entry.repoRoot, entry.tree)
      if (!res.ok) {
        log.warn('end checkpoint diff failed', { threadId, error: res.error })
        return []
      }
      return res.files.map((f) => ({
        type: 'file.edited',
        threadId,
        turnId: entry.turnId,
        fileEditId: `${entry.turnId}:${f.relPath}`,
        repoRoot: entry.repoRoot,
        relPath: f.relPath,
        changeKind: f.changeKind,
        oldContent: f.oldContent,
        newContent: f.newContent,
      }))
    } catch (err) {
      log.warn('finishTurn failed', { threadId, err })
      return []
    }
  }

  /** Drop any pending checkpoint for a thread (e.g. on session stop). */
  clear(threadId: string): void {
    this.pending.delete(threadId)
  }
}
