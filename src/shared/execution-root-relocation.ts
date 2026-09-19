/**
 * The wire contract for moving a conversation's execution root.
 *
 * "Follow" used to be a renderer setter: it wrote `worktree_path` and updated
 * the branch chip while the live provider kept running in the directory it was
 * spawned in. The screen and the process then disagreed, the next tool call
 * came from the old checkout, and the app offered to follow all over again.
 *
 * Relocation is therefore modelled as a TRANSACTION owned by the backend that
 * owns the path, not as a state update. This module holds the parts that must
 * be identical on every client - Desktop, iOS, Android - plus the precondition
 * decision, which is pure so it can be tested without a live registry.
 *
 * Note what is NOT here: filesystem and git checks. Whether the target exists,
 * and whether it belongs to the same repository, can only be answered on the
 * machine that owns the path, so they live in the coordinator.
 */

import type { ExecutionRoot } from './execution-root'
import { normalizeRootPath, sameExecutionRoot, resolveExecutionRoot } from './execution-root'

/** Why the root is moving. Carried through to logs and to the drift watcher. */
export type RelocationReason =
  /** The user accepted a `worktree.drift` suggestion. */
  | 'drift-follow'
  /** The user picked a branch that is checked out in another worktree. */
  | 'branch-picker'
  /** The recorded worktree vanished and we are falling back to the checkout. */
  | 'orphan-heal'
  /** An explicit user action with no suggestion behind it. */
  | 'manual'

export interface RelocateExecutionRootRequest {
  threadId: string
  /**
   * The revision the caller believes is current. A relocation commits only if
   * this still matches, so a phone that was asleep cannot drag the root back.
   */
  expectedRevision: number
  /** Absolute path on `machineId`. */
  targetPath: string
  /** Advisory only. The backend resolves the real branch from git. */
  targetBranch?: string | null
  /** Backend that owns `targetPath`. */
  machineId: string
  reason: RelocationReason
  /**
   * Set only after the user is told context will be lost. Without it a
   * provider that cannot resume in a new directory is refused rather than
   * silently restarted empty.
   */
  acceptContinuityLoss?: boolean
}

export type RelocationFailureCode =
  /** Another relocation, a start, or a profile switch holds the thread. */
  | 'busy'
  /** `expectedRevision` does not match the committed revision. */
  | 'stale-revision'
  /** The request names a backend that does not own this thread. */
  | 'wrong-machine'
  /** Blank, relative, or otherwise unusable target path. */
  | 'invalid-target'
  /** Nothing at the target path on the owning machine. */
  | 'target-missing'
  /** The target is a git worktree of a DIFFERENT repository. */
  | 'different-repository'
  /** The provider cannot carry its thread into a new directory. */
  | 'continuity-unsupported'
  /** The thread is not known to the backend. */
  | 'unknown-thread'
  /**
   * The source provider could not be stopped, so the move never started.
   * Distinct from a failed start: there is nothing to roll back, and the
   * adapter may be in an unknown state, so a retry is not obviously safe.
   */
  | 'source-stop-failed'
  /** The provider failed to start at the target. The source was restored. */
  | 'target-start-failed'
  /** The provider failed to start AND could not be restored. Needs the user. */
  | 'rollback-failed'

/** Whether trying the same request again could plausibly succeed. */
export function isRelocationRetryable(code: RelocationFailureCode): boolean {
  return code === 'busy' || code === 'stale-revision'
}

/** How much of the conversation survived the move. */
export type RelocationContinuity =
  /** The provider resumed its native thread in the new directory. */
  | 'preserved'
  /** There was no live provider to preserve. */
  | 'not-needed'
  /** The provider restarted cold. Only possible with `acceptContinuityLoss`. */
  | 'degraded'

export type TerminalRelocationSkipReason =
  | 'busy'
  | 'remote-login'
  | 'unsubmitted-input'
  | 'unsupported-shell'
  | 'outside-root'
  | 'other-machine'
  | 'no-acknowledgement'

export interface TerminalReconciliationSummary {
  moved: number
  /** Moved, but the matching subdirectory was absent so they landed at the root. */
  fallback: number
  skipped: Array<{ paneId: string; reason: TerminalRelocationSkipReason }>
}

export type RelocateExecutionRootResult =
  | {
    ok: true
    /** `queued` means it commits at the next turn boundary. */
    outcome: 'relocated' | 'already-at-target' | 'queued'
    root: ExecutionRoot
    continuity: RelocationContinuity
    terminals?: TerminalReconciliationSummary
  }
  | {
    ok: false
    code: RelocationFailureCode
    message: string
    /** True when a failed start was undone and the source provider is live again. */
    rolledBack?: boolean
    /** The root as it stands after the failure. Unchanged unless `rollback-failed`. */
    root: ExecutionRoot
  }

/** Providers that can carry a live thread into a different working directory. */
const CONTINUITY_CAPABLE_PROVIDERS = new Set(['claude', 'codex'])

export interface RelocationPreconditionState {
  request: RelocateExecutionRootRequest
  currentRoot: ExecutionRoot
  /** A provider process is attached to this thread right now. */
  threadIsLive: boolean
  relocating: boolean
  starting: boolean
  switchingProfile: boolean
  preparingTurn: boolean
  turnActive: boolean
  provider: string
}

export type RelocationPreconditionVerdict =
  /** Run the full stop/migrate/start transaction. */
  | { verdict: 'proceed' }
  /** No provider to move. Persist the new root and let the next start use it. */
  | { verdict: 'proceed-detached' }
  /** Commit at the next safe turn boundary. */
  | { verdict: 'queue' }
  | { verdict: 'already-at-target' }
  | { verdict: 'reject'; code: RelocationFailureCode; message: string }

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

/**
 * Decide what to do with a relocation request, without touching the disk.
 *
 * The ordering matters and is not arbitrary:
 *
 *   - validity and revision first, so a stale or malformed request is refused
 *     the same way whether or not a turn happens to be running;
 *   - contention next, because a half-finished profile switch must not be
 *     interleaved with a root move that shares the same snapshot machinery;
 *   - the turn check LAST among the blocking checks, because the answer there
 *     is "queue", not "fail". A drift suggestion almost always arrives during
 *     a turn, and killing that turn to satisfy a UI click is worse than
 *     waiting a few seconds for it to finish.
 */
export function classifyRelocationPreconditions(
  state: RelocationPreconditionState,
): RelocationPreconditionVerdict {
  const { request, currentRoot } = state

  const target = request.targetPath?.trim() ?? ''
  if (!target || !ABSOLUTE_PATH.test(target)) {
    return {
      verdict: 'reject',
      code: 'invalid-target',
      message: 'A relocation target must be an absolute path on the owning machine.',
    }
  }

  if (request.machineId !== currentRoot.machineId) {
    return {
      verdict: 'reject',
      code: 'wrong-machine',
      message: `This conversation runs on ${currentRoot.machineId}, not ${request.machineId}.`,
    }
  }

  // Equality, not "less than". A revision from the future is just as wrong as
  // one from the past: it means the caller is reasoning about a state this
  // backend never published.
  if (request.expectedRevision !== currentRoot.revision) {
    return {
      verdict: 'reject',
      code: 'stale-revision',
      message: 'The execution root moved since this request was made. Reload and try again.',
    }
  }

  const targetRoot = resolveExecutionRoot({
    projectPath: currentRoot.projectPath,
    worktreePath: normalizeRootPath(target),
    machineId: currentRoot.machineId,
  })
  if (sameExecutionRoot(targetRoot, currentRoot)) return { verdict: 'already-at-target' }

  if (state.relocating || state.starting || state.switchingProfile) {
    return {
      verdict: 'reject',
      code: 'busy',
      message: 'This conversation is already changing. Try again in a moment.',
    }
  }

  if (!state.threadIsLive) return { verdict: 'proceed-detached' }

  // Continuity is a provider CAPABILITY, not a timing condition, so it is
  // refused before the turn check. Queued first, it would be answered with
  // `ok: queued`, then rejected at the turn boundary where the failure only
  // reaches a log - and a drift suggestion almost always arrives during a
  // turn, so that is the common path for a provider that cannot carry its
  // thread, not a corner of it.
  if (!CONTINUITY_CAPABLE_PROVIDERS.has(state.provider) && !request.acceptContinuityLoss) {
    return {
      verdict: 'reject',
      code: 'continuity-unsupported',
      message: 'This provider cannot carry the conversation into another directory. Restarting it here would lose the thread.',
    }
  }

  if (state.turnActive || state.preparingTurn) return { verdict: 'queue' }

  return { verdict: 'proceed' }
}
