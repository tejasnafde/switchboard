/**
 * Moving a conversation's execution root, as one transaction.
 *
 * "Follow" used to be a renderer setter, so the screen moved and the provider
 * did not. The fix is not a bigger setter: it is a transaction with a single
 * commit boundary, which is a SUCCESSFUL PROVIDER START AT THE TARGET.
 *
 * Before that boundary nothing durable changes, so every failure leaves the
 * conversation exactly where it was. After it, the durable pointer, the
 * registry's runtime state and every connected client move together.
 *
 * This module owns the ORDER and the DECISIONS. The effects - git, the
 * adapters, SQLite, the event bus - live behind `ExecutionRootHost`, which the
 * provider registry implements. That split is not ceremony: rollback, a
 * revision changing mid-flight, and a relocation queued behind a running turn
 * are the paths that matter most and the ones a live registry makes hardest to
 * reach on purpose.
 */
import { createMainLogger } from '../logger'
import type { RuntimeEvent } from '@shared/provider-events'
import { resolveExecutionRoot, type ExecutionRoot } from '@shared/execution-root'
import {
  classifyRelocationPreconditions,
  type RelocateExecutionRootRequest,
  type RelocateExecutionRootResult,
  type RelocationContinuity,
  type RelocationFailureCode,
} from '@shared/execution-root-relocation'

const log = createMainLogger('provider:execution-root')

/** Opaque to this module: only the host knows what restarting a provider needs. */
export type ProviderHandle = { readonly __brand: unique symbol }

export type TargetResolution =
  | { ok: true; path: string; branch: string | null }
  | { ok: false; code: Extract<RelocationFailureCode, 'target-missing' | 'different-repository' | 'invalid-target'>; message: string }

export type AttachResult =
  | { ok: true; continuity: RelocationContinuity }
  | { ok: false; code: Extract<RelocationFailureCode, 'target-start-failed'>; message: string }

export interface RelocationSessionState {
  threadIsLive: boolean
  starting: boolean
  switchingProfile: boolean
  preparingTurn: boolean
  turnActive: boolean
  provider: string
}

export interface ExecutionRootHost {
  /**
   * The committed root, or null when the thread is unknown to this backend.
   *
   * `machineId` comes from the REQUEST, and is passed on every call rather
   * than stashed: this host serves concurrent relocations for different
   * threads, and a single shared field would let one request's machine
   * identity be read by another that happened to be mid-await.
   */
  currentRoot(threadId: string, machineId: string): ExecutionRoot | null
  sessionState(threadId: string): RelocationSessionState | null
  /**
   * Verify the target ON THE OWNING MACHINE and resolve its real branch.
   * Asynchronous, which is why the revision is re-checked afterwards.
   */
  resolveTarget(currentRoot: ExecutionRoot, targetPath: string): Promise<TargetResolution>
  /** Drain and stop the provider, returning everything needed to start it again. */
  detachProvider(threadId: string): Promise<ProviderHandle>
  /**
   * Start the provider at `path`, preserving its native thread where it can.
   *
   * `mode` is explicit because the host must behave differently on a rollback
   * (discard events staged by the failed target, publish provider identity)
   * and inferring it by comparing `path` to the source was a string compare
   * that a trailing separator or a realpath could silently get wrong - which
   * would have left the restored session's output staged forever.
   */
  attachProvider(handle: ProviderHandle, path: string, mode: 'target' | 'restore'): Promise<AttachResult>
  /** Persist the pointer and bump the revision atomically. Null when no row matched. */
  commitRoot(threadId: string, path: string, branch: string | null): number | null
  /**
   * Make the running backend reflect the committed root: re-root cwd, the
   * drift baseline, checkpoints, notebooks and IDE routing, and release any
   * provider events staged during the move. Called once, only after the
   * durable commit succeeded.
   */
  commitRuntime(threadId: string, path: string, revision: number): void
  publish(event: RuntimeEvent): void
}

interface QueuedRelocation {
  request: RelocateExecutionRootRequest
  /** The revision the request was admitted against. */
  admittedAtRevision: number
}

export class ExecutionRootCoordinator {
  /** Threads with a relocation in flight. The claim a profile switch also respects. */
  private readonly relocating = new Set<string>()
  /** Relocations waiting for a turn to finish. One per thread; a later one supersedes. */
  private readonly queued = new Map<string, QueuedRelocation>()

  constructor(private readonly host: ExecutionRootHost) {}

  isRelocating(threadId: string): boolean {
    return this.relocating.has(threadId)
  }

  /** True while a relocation waits for a turn boundary. New turns are refused. */
  hasQueued(threadId: string): boolean {
    return this.queued.has(threadId)
  }

  /** A stopped session has no root to move and no turn to wait for. */
  onSessionStopped(threadId: string): void {
    this.queued.delete(threadId)
  }

  /**
   * A turn ended. Commit whatever was waiting for it.
   *
   * The queued request is re-validated against the CURRENT revision rather
   * than replayed: while it waited, another client may have moved the root,
   * and replaying a stale request would drag it back.
   */
  async onTurnBoundary(threadId: string): Promise<void> {
    const pending = this.queued.get(threadId)
    if (!pending) return
    this.queued.delete(threadId)
    const current = this.host.currentRoot(threadId, pending.request.machineId)
    if (!current || current.revision !== pending.request.expectedRevision) {
      log.info('dropping queued relocation - the root moved while it waited', {
        threadId,
        expected: pending.request.expectedRevision,
        actual: current?.revision ?? null,
      })
      return
    }
    const result = await this.relocate(pending.request)
    if (!result.ok) {
      log.warn(`queued relocation for ${threadId} failed: ${result.code} ${result.message}`)
    }
  }

  async relocate(request: RelocateExecutionRootRequest): Promise<RelocateExecutionRootResult> {
    const currentRoot = this.host.currentRoot(request.threadId, request.machineId)
    if (!currentRoot) {
      return this.fail('unknown-thread', 'This conversation is not known to this backend.', unknownRoot(request))
    }

    const sessionState = this.host.sessionState(request.threadId) ?? DETACHED
    const verdict = classifyRelocationPreconditions({
      request,
      currentRoot,
      relocating: this.relocating.has(request.threadId),
      ...sessionState,
    })

    switch (verdict.verdict) {
      case 'reject':
        return this.fail(verdict.code, verdict.message, currentRoot)
      case 'already-at-target':
        return { ok: true, outcome: 'already-at-target', root: currentRoot, continuity: 'not-needed' }
      case 'queue':
        this.queued.set(request.threadId, { request, admittedAtRevision: currentRoot.revision })
        return { ok: true, outcome: 'queued', root: currentRoot, continuity: 'not-needed' }
      default:
        break
    }

    this.relocating.add(request.threadId)
    try {
      return await this.run(request, currentRoot, verdict.verdict === 'proceed-detached')
    } finally {
      this.relocating.delete(request.threadId)
    }
  }

  private async run(
    request: RelocateExecutionRootRequest,
    rootAtAdmission: ExecutionRoot,
    detached: boolean,
  ): Promise<RelocateExecutionRootResult> {
    const target = await this.host.resolveTarget(rootAtAdmission, request.targetPath)
    if (!target.ok) return this.fail(target.code, target.message, rootAtAdmission)

    // Validation touches the filesystem and git, so it yields. Another client,
    // or a queued relocation on another thread of the same conversation, may
    // have committed in the meantime. Re-check before anything is stopped:
    // this is the last point where abandoning is free.
    const rootNow = this.host.currentRoot(request.threadId, request.machineId)
    if (!rootNow) {
      return this.fail('unknown-thread', 'The conversation disappeared during validation.', rootAtAdmission)
    }
    if (rootNow.revision !== request.expectedRevision) {
      return this.fail(
        'stale-revision',
        'The execution root moved while this request was being checked.',
        rootNow,
      )
    }

    if (detached) return this.commitDetached(request, rootNow, target)

    let handle: ProviderHandle
    try {
      handle = await this.host.detachProvider(request.threadId)
    } catch (err) {
      // Nothing has moved and there is nothing to roll back: the durable
      // pointer and the runtime are both untouched. Reported separately from
      // a failed START, because the adapter may be half torn down and a
      // retry is not obviously safe.
      const message = err instanceof Error ? err.message : String(err)
      log.error(`could not stop ${request.threadId} for relocation`, err)
      return this.fail('source-stop-failed', message, rootNow)
    }

    const attached = await this.host.attachProvider(handle, target.path, 'target')
    if (!attached.ok) {
      return this.rollback(request, rootNow, handle, attached.code, attached.message)
    }

    const revision = this.host.commitRoot(request.threadId, target.path, target.branch)
    if (revision === null) {
      // The provider is already running at the target but there is nowhere
      // durable to record it. Put it back rather than leave the process and
      // the database disagreeing, which is the exact defect being fixed.
      return this.rollback(
        request,
        rootNow,
        handle,
        'unknown-thread',
        'The conversation row disappeared before the move could be recorded.',
      )
    }

    return this.finish(request, rootNow, target, revision, attached.continuity)
  }

  private commitDetached(
    request: RelocateExecutionRootRequest,
    from: ExecutionRoot,
    target: Extract<TargetResolution, { ok: true }>,
  ): RelocateExecutionRootResult {
    const revision = this.host.commitRoot(request.threadId, target.path, target.branch)
    if (revision === null) {
      return this.fail('unknown-thread', 'The conversation row disappeared before the move could be recorded.', from)
    }
    return this.finish(request, from, target, revision, 'not-needed')
  }

  private finish(
    request: RelocateExecutionRootRequest,
    from: ExecutionRoot,
    target: Extract<TargetResolution, { ok: true }>,
    revision: number,
    continuity: RelocationContinuity,
  ): RelocateExecutionRootResult {
    this.host.commitRuntime(request.threadId, target.path, revision)
    const to = resolveExecutionRoot({
      projectPath: from.projectPath,
      worktreePath: target.path,
      worktreeBranch: target.branch,
      machineId: from.machineId,
      executionRootRevision: revision,
    })
    this.host.publish({
      type: 'session.execution-root-changed',
      threadId: request.threadId,
      machineId: from.machineId,
      from: { path: from.path, branch: from.branch },
      to: { path: to.path, branch: to.branch, isWorktree: to.isWorktree },
      revision,
      reason: request.reason,
      continuity,
    })
    log.info('execution root relocated', {
      threadId: request.threadId,
      from: from.path,
      to: to.path,
      revision,
      reason: request.reason,
      continuity,
    })
    return { ok: true, outcome: 'relocated', root: to, continuity }
  }

  /**
   * Put the provider back where it was.
   *
   * A failed restore is reported separately and deliberately: the user has no
   * running provider at either root, and telling them "nothing happened" would
   * be false.
   */
  private async rollback(
    request: RelocateExecutionRootRequest,
    from: ExecutionRoot,
    handle: ProviderHandle,
    code: RelocationFailureCode,
    message: string,
  ): Promise<RelocateExecutionRootResult> {
    try {
      const restored = await this.host.attachProvider(handle, from.path, 'restore')
      if (!restored.ok) throw new Error(restored.message)
    } catch (err) {
      log.error(`could not restore ${request.threadId} to ${from.path}`, err)
      return this.fail(
        'rollback-failed',
        `${message} The conversation could not be restarted in its original directory either.`,
        from,
      )
    }
    log.warn(`relocation of ${request.threadId} failed (${code}); restored ${from.path}`)
    return { ok: false, code, message, rolledBack: true, root: from }
  }

  private fail(
    code: RelocationFailureCode,
    message: string,
    root: ExecutionRoot,
  ): RelocateExecutionRootResult {
    return { ok: false, code, message, root }
  }
}

/** A thread the host knows nothing about still needs a root to report back. */
function unknownRoot(request: RelocateExecutionRootRequest): ExecutionRoot {
  return resolveExecutionRoot({ projectPath: '', machineId: request.machineId })
}

const DETACHED: RelocationSessionState = {
  threadIsLive: false,
  starting: false,
  switchingProfile: false,
  preparingTurn: false,
  turnActive: false,
  provider: 'unknown',
}
