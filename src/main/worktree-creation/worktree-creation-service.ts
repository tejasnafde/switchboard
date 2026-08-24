import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalizeWorktreeCreationIdentity,
  canonicalizeWorktreeCreationRequest,
  parseWorktreeCreationRequest,
  type GetWorktreeCreationRequest,
  type WorktreeCreationActionRequest,
  type WorktreeCreationProgressEvent,
  type WorktreeCreationRequest,
  type WorktreeCreationError,
  type WorktreeSetupReceipt,
  type WorktreeStartupReceipt,
  type WorkspaceLaunchIntent,
  type WorktreeCreationSnapshot,
} from '../../shared/worktree-creation'
import type { WorktreeSetupConfig } from '../../shared/launch-config'
import {
  authorizeWorktreeCreationAction,
  authorizeWorktreeCreationRequest,
} from './authorization'
import {
  type WorktreeCreationRecord,
  SqliteWorktreeCreationStore,
} from '../db/worktree-creation'
import { createMainLogger } from '../logger'
import type {
  ResolvedGitRepository,
  WorktreeMaterializationInspection,
  WorktreeMaterializationIntent,
  WorktreeMaterializationPlan,
  WorktreeMaterializationResult,
  WorktreeRollbackMode,
  WorktreeRollbackResult,
} from './git-adapter'
import { resolveWorktreeSetup } from './setup-policy'

const log = createMainLogger('worktree:creation')

export interface GitWorktreePort {
  resolveRepository(projectPath: string): Promise<ResolvedGitRepository>
  planMaterialization(intent: WorktreeMaterializationIntent): Promise<WorktreeMaterializationPlan>
  materialize(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationResult>
  inspectMaterialization(plan: WorktreeMaterializationPlan): Promise<WorktreeMaterializationInspection>
  configureSparse(
    plan: WorktreeMaterializationPlan,
    directories: string[],
  ): Promise<{ mode: 'cone'; directories: string[]; status: 'configured' }>
  rollbackMaterialization(
    plan: WorktreeMaterializationPlan,
    mode?: WorktreeRollbackMode,
  ): Promise<WorktreeRollbackResult>
}

export interface WorktreeCreationProgressSink {
  publish(event: WorktreeCreationProgressEvent): void
}

export interface WorktreeSetupConfigPort {
  load(projectPath: string): Promise<WorktreeSetupConfig | undefined>
}

export interface WorktreeSetupRunnerPort {
  run(input: {
    creationId: string
    cwd: string
    command: string
    signal?: AbortSignal
  }): Promise<
    | { kind: 'succeeded'; exitCode?: number }
    | { kind: 'failed'; exitCode?: number }
    | { kind: 'outcome_unknown' }
  >
}

export interface WorktreeStartupLauncherPort {
  launch(input: {
    creationId: string
    projectPath: string
    worktreePath: string
    branch: string
    conversationId: string
    initialPromptOrigin: string
    launch: WorkspaceLaunchIntent
  }): Promise<WorktreeStartupReceipt>
}

export type ForkWorktreeCreationRequest = WorktreeCreationRequest & {
  owner: Extract<WorktreeCreationRequest['owner'], { kind: 'fork' }>
}

export interface ForkWorktreeOwnerStage {
  artifactPath?: string
}

export interface ForkWorktreeOwnerPrepareInput {
  request: ForkWorktreeCreationRequest
  plan: WorktreeMaterializationPlan
}

export interface ForkWorktreeOwnerCommitInput {
  request: ForkWorktreeCreationRequest
  stage: ForkWorktreeOwnerStage
  machineId: string
  creationId: string
  expectedRevision: number
  worktree: {
    id: string
    repositoryId: string
    projectPath: string
    worktreePath: string
    branch: string
    requestedBaseRef: string
    resolvedBaseCommit: string
  }
  now: number
}

export type ForkWorktreeOwnerCommitResult =
  | { kind: 'committed'; record: WorktreeCreationRecord }
  | { kind: 'stale'; record: WorktreeCreationRecord }
  | { kind: 'missing' }

export interface ForkWorktreeOwnerPort {
  prepare(input: ForkWorktreeOwnerPrepareInput): Promise<ForkWorktreeOwnerStage>
  publish(stage: ForkWorktreeOwnerStage): Promise<void>
  commit(input: ForkWorktreeOwnerCommitInput): Promise<ForkWorktreeOwnerCommitResult>
  compensate(stage: ForkWorktreeOwnerStage): Promise<void>
  isCommitted(key: { machineId: string; creationId: string }): boolean
}

export interface WorktreeCreationServiceOptions {
  store: SqliteWorktreeCreationStore
  git: GitWorktreePort
  progressSink: WorktreeCreationProgressSink
  now?: () => number
  createWorktreeId?: () => string
  userDataDir?: string
  setupConfig?: WorktreeSetupConfigPort
  setupRunner?: WorktreeSetupRunnerPort
  startupLauncher?: WorktreeStartupLauncherPort
  forkOwner?: ForkWorktreeOwnerPort
}

interface InFlightCreation {
  payloadHash: string
  promise: Promise<WorktreeCreationSnapshot>
}

type WorktreeCreationContinuation = () => Promise<WorktreeCreationSnapshot>
type WorktreeCreationStep = WorktreeCreationSnapshot | WorktreeCreationContinuation

class RepositoryMutationQueue {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(repositoryId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repositoryId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(repositoryId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(repositoryId) === current) this.tails.delete(repositoryId)
    }
  }
}

export class WorktreeCreationConflictError extends Error {
  override readonly name = 'WorktreeCreationConflictError'

  constructor(readonly creationId: string) {
    super(`creationId ${creationId} is already bound to a different worktree creation payload`)
  }
}

export class WorktreeCreationValidationError extends Error {
  override readonly name = 'WorktreeCreationValidationError'
}

export class WorktreeCreationOwnerConflictError extends Error {
  override readonly name = 'WorktreeCreationOwnerConflictError'
}

export class WorktreeCreationNotFoundError extends Error {
  override readonly name = 'WorktreeCreationNotFoundError'
}

export class WorktreeCreationRevisionConflictError extends Error {
  override readonly name = 'WorktreeCreationRevisionConflictError'
}

export class WorktreeCreationUnsafeActionError extends Error {
  override readonly name = 'WorktreeCreationUnsafeActionError'
}

export class WorktreeCreationService {
  private readonly now: () => number
  private readonly createWorktreeId: () => string
  private readonly inFlight = new Map<string, InFlightCreation>()
  private readonly recoveryInFlight = new Map<string, Promise<void>>()
  private readonly repositoryMutations = new RepositoryMutationQueue()

  private launchConversationId(request: WorktreeCreationRequest): string {
    if (request.owner.kind === 'conversation' || request.owner.kind === 'fork') {
      return request.owner.conversationId
    }
    return `kanban-${createHash('sha256').update(request.creationId).digest('hex').slice(0, 24)}`
  }

  private kanbanOwnerConflictMessage(cardId: string, reason: string): string {
    if (reason === 'card_has_conversation') {
      return `Kanban card ${cardId} already has a conversation. Continue using that conversation instead of replacing it with a worktree-backed agent.`
    }
    return `Kanban owner ${cardId} failed its ${reason} precondition.`
  }

  constructor(private readonly options: WorktreeCreationServiceOptions) {
    this.now = options.now ?? Date.now
    this.createWorktreeId = options.createWorktreeId ?? (() => `worktree_${randomUUID()}`)
  }

  private completeStep(step: WorktreeCreationStep): Promise<WorktreeCreationSnapshot> {
    return typeof step === 'function' ? step() : Promise.resolve(step)
  }

  private async runSetupSafely(input: Parameters<WorktreeSetupRunnerPort['run']>[0]) {
    if (!this.options.setupRunner) return { kind: 'failed' as const }
    try {
      return await this.options.setupRunner.run(input)
    } catch {
      log.warn('setup runner port threw after the external boundary; treating the outcome as ambiguous')
      return { kind: 'outcome_unknown' as const }
    }
  }

  private async launchStartupSafely(
    input: Parameters<WorktreeStartupLauncherPort['launch']>[0],
  ): Promise<WorktreeStartupReceipt> {
    if (!this.options.startupLauncher) return { status: 'failed', terminalIds: [] }
    try {
      return await this.options.startupLauncher.launch(input)
    } catch {
      log.warn('startup launcher port threw after the external boundary; treating the outcome as ambiguous')
      return {
        status: 'ambiguous',
        terminalIds: [],
        initialPromptOrigin: input.initialPromptOrigin,
      }
    }
  }

  async recoverInterruptedCreations(): Promise<void> {
    await Promise.all(this.options.store.listRecoverable().map(async (record) => {
      try {
        await this.recoverOnce(record)
      } catch (error) {
        const failed = this.options.store.updateProgress({
          machineId: record.machineId,
          creationId: record.creationId,
          expectedRevision: this.options.store.get(record)?.revision ?? record.revision,
          phase: record.phase,
          status: 'cleanup_required',
          errorJson: JSON.stringify({
            code: 'recovery_failed',
            phase: record.phase,
            message: error instanceof Error ? error.message : 'Worktree recovery failed.',
            retryable: false,
          }),
          now: this.now(),
        })
        if (failed.kind === 'updated') this.publish(failed.record)
      }
    }))
  }

  async getWorktreeCreation(input: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot> {
    const record = this.options.store.get(input)
    if (!record) throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
    return this.snapshot(record)
  }

  async actOnWorktreeCreation(input: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot> {
    const current = this.options.store.get(input)
    if (!current) throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
    if (current.revision !== input.expectedRevision) {
      throw new WorktreeCreationRevisionConflictError(
        `Worktree creation ${input.creationId} changed before the action was applied.`,
      )
    }
    authorizeWorktreeCreationAction(
      JSON.parse(current.requestJson) as WorktreeCreationRequest,
      input.action,
    )
    if (input.action === 'cancel' && current.phase === 'pending' && current.status === 'pending') {
      return this.transitionFromAction(input, current.phase, 'cancelled')
    }
    if (
      current.phase === 'awaiting_setup_decision' &&
      current.status === 'pending' &&
      (input.action === 'choose_setup_skip' || input.action === 'choose_setup_run')
    ) {
      if (!current.materializationPlanJson) {
        throw new WorktreeCreationUnsafeActionError('The reserved materialization plan is unavailable.')
      }
      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      const plan = JSON.parse(current.materializationPlanJson) as WorktreeMaterializationPlan
      if (input.action === 'choose_setup_skip') {
        const previous = current.setupReceiptJson
          ? JSON.parse(current.setupReceiptJson) as WorktreeSetupReceipt
          : undefined
        const skipped = this.options.store.updateProgress({
          ...input,
          phase: 'provisioning',
          status: 'pending',
          setupReceiptJson: JSON.stringify({
            requestedPolicy: previous?.requestedPolicy ?? request.setup.policy,
            resolvedPolicy: 'skip',
            status: 'skipped',
          } satisfies WorktreeSetupReceipt),
          now: this.now(),
        })
        if (skipped.kind !== 'updated') {
          if (skipped.kind === 'stale') return this.snapshot(skipped.record)
          throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
        }
        this.publish(skipped.record)
        return this.finishAfterSetup(request, skipped.record)
      }
      const approvedSetup = current.setupReceiptJson
        ? JSON.parse(current.setupReceiptJson) as WorktreeSetupReceipt
        : undefined
      return this.provisionSetup(request, plan, current, 'run', approvedSetup?.commandFingerprint)
    }
    if (
      input.action === 'retry'
      && (current.status === 'failed' || current.status === 'rolled_back')
      && (current.phase === 'materializing' || current.phase === 'configuring' || current.phase === 'linking')
    ) {
      if (!current.materializationPlanJson) {
        throw new WorktreeCreationUnsafeActionError('The reserved materialization plan is unavailable.')
      }
      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      const plan = JSON.parse(current.materializationPlanJson) as WorktreeMaterializationPlan
      const step = await this.repositoryMutations.run(plan.repository.repositoryId, async () => {
        const pending = this.options.store.transition({
          ...input,
          phase: 'materializing',
          status: 'pending',
          now: this.now(),
        })
        if (pending.kind !== 'updated') {
          if (pending.kind === 'missing') {
            throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
          }
          throw new WorktreeCreationRevisionConflictError(
            `Worktree creation ${input.creationId} changed before the action was applied.`,
          )
        }
        this.publish(pending.record)
        return this.materializeAndContinue(request, plan.repository, plan, pending.record)
      })
      return this.completeStep(step)
    }
    if (input.action === 'retry' && current.status === 'cleanup_required' && current.phase === 'provisioning') {
      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      const startupReceipt = current.startupReceiptJson
        ? JSON.parse(current.startupReceiptJson) as WorktreeStartupReceipt
        : undefined
      if (
        request.launch
        && startupReceipt?.status === 'ambiguous'
      ) {
        return this.provisionStartup(request, current)
      }
    }
    if (current.status === 'cleanup_required' && input.action === 'retain') {
      return this.finalizeCleanup(input, 'retained')
    }
    if ((current.status === 'cleanup_required' || current.status === 'ready') && input.action === 'remove') {
      const request = JSON.parse(current.requestJson) as WorktreeCreationRequest
      if (request.owner.kind === 'fork') {
        throw new WorktreeCreationUnsafeActionError('Fork worktrees must be retained for explicit manual recovery.')
      }
      if (!current.materializationPlanJson) {
        throw new WorktreeCreationUnsafeActionError('The reserved materialization plan is unavailable.')
      }
      const plan = JSON.parse(current.materializationPlanJson) as WorktreeMaterializationPlan
      return this.repositoryMutations.run(plan.repository.repositoryId, async () => {
        const rollback = await this.options.git.rollbackMaterialization(plan, 'explicit_remove')
        if (rollback.kind === 'removed' || rollback.kind === 'absent') {
          return this.finalizeCleanup(input, 'removed')
        }
        return current.status === 'ready'
          ? this.recordReadyRemovalRefusal(input, current, rollback.reason)
          : this.finalizeCleanup(input, 'removal_refused')
      })
    }
    throw new WorktreeCreationUnsafeActionError(
      `Action ${input.action} is not safe for ${current.phase}/${current.status}.`,
    )
  }

  private async transitionFromAction(
    input: WorktreeCreationActionRequest,
    phase: WorktreeCreationRecord['phase'],
    status: WorktreeCreationRecord['status'],
  ): Promise<WorktreeCreationSnapshot> {
    const result = this.options.store.transition({ ...input, phase, status, now: this.now() })
    if (result.kind === 'missing') {
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
    }
    if (result.kind === 'stale') {
      throw new WorktreeCreationRevisionConflictError(
        `Worktree creation ${input.creationId} changed before the action was applied.`,
      )
    }
    this.publish(result.record)
    return this.snapshot(result.record)
  }

  private finalizeCleanup(
    input: WorktreeCreationActionRequest,
    disposition: 'retained' | 'removed' | 'removal_refused',
  ): WorktreeCreationSnapshot {
    const result = this.options.store.finalizeCleanup({
      ...input,
      disposition,
      now: this.now(),
    })
    if (result.kind === 'missing') {
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
    }
    if (result.kind === 'stale') {
      throw new WorktreeCreationRevisionConflictError(
        `Worktree creation ${input.creationId} changed before the action was applied.`,
      )
    }
    this.publish(result.record)
    return this.snapshot(result.record)
  }

  private recordReadyRemovalRefusal(
    input: WorktreeCreationActionRequest,
    current: WorktreeCreationRecord,
    reason: Extract<WorktreeRollbackResult, { kind: 'refused' }>['reason'],
  ): WorktreeCreationSnapshot {
    const result = this.options.store.updateProgress({
      ...input,
      phase: 'ready',
      status: 'ready',
      recoveryJson: JSON.stringify({ disposition: 'removal_refused', reason }),
      errorJson: JSON.stringify({
        code: 'removal_refused',
        phase: 'ready',
        message: `The ready worktree remains active because removal was refused: ${reason}.`,
        retryable: true,
      } satisfies WorktreeCreationError),
      now: this.now(),
    })
    if (result.kind === 'missing') {
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${input.creationId}.`)
    }
    if (result.kind === 'stale') {
      throw new WorktreeCreationRevisionConflictError(
        `Worktree creation ${input.creationId} changed before the action was applied.`,
      )
    }
    log.warn('ready worktree removal refused; preserving active ownership', {
      machineId: current.machineId,
      creationId: current.creationId,
      reason,
    })
    this.publish(result.record)
    return this.snapshot(result.record)
  }

  async createWorktreeTransaction(input: unknown): Promise<WorktreeCreationSnapshot> {
    const parsed = parseWorktreeCreationRequest(input)
    if (!parsed.ok) {
      throw new WorktreeCreationValidationError(parsed.issues.map((issue) => issue.message).join(' '))
    }
    const request = authorizeWorktreeCreationRequest(parsed.value)
    const payloadHash = createHash('sha256')
      .update(canonicalizeWorktreeCreationIdentity(request))
      .digest('hex')
    const key = `${request.repository.machineId}\u0000${request.creationId}`
    const running = this.inFlight.get(key)
    if (running) {
      if (running.payloadHash !== payloadHash) throw new WorktreeCreationConflictError(request.creationId)
      return running.promise
    }

    const promise = this.create(request, payloadHash)
    this.inFlight.set(key, { payloadHash, promise })
    try {
      return await promise
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key)
    }
  }

  private async create(
    request: WorktreeCreationRequest,
    payloadHash: string,
  ): Promise<WorktreeCreationSnapshot> {
    const key = {
      machineId: request.repository.machineId,
      creationId: request.creationId,
    }
    const existing = this.options.store.get(key)
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new WorktreeCreationConflictError(request.creationId)
      if (existing.status === 'pending') {
        await this.recoverOnce(existing)
        const reconciled = this.options.store.get(key)
        if (reconciled) return this.snapshot(reconciled)
      }
      return this.snapshot(existing)
    }
    if (request.owner.kind === 'fork' && !this.options.forkOwner) {
      throw new WorktreeCreationValidationError('This worktree creation owner is not implemented yet.')
    }
    if (request.owner.kind === 'kanban-card') {
      const ownerCheck = this.options.store.checkKanbanOwner(request.owner, request.repository.projectPath)
      if (ownerCheck.kind === 'owner_conflict') {
        throw new WorktreeCreationOwnerConflictError(
          this.kanbanOwnerConflictMessage(request.owner.cardId, ownerCheck.reason),
        )
      }
    }

    const repository = await this.options.git.resolveRepository(request.repository.projectPath)
    const plan = await this.options.git.planMaterialization({
      repository,
      creationId: request.creationId,
      baseRef: request.checkout.baseRef,
      branch: request.checkout.branch,
      location: request.checkout.location ?? 'managed-user-data',
      userDataDir: this.options.userDataDir,
    })
    const requestJson = canonicalizeWorktreeCreationRequest(request)
    const worktreeId = this.createWorktreeId()
    const reservationInput = {
      ...key,
      schemaVersion: request.schemaVersion,
      requestJson,
      payloadHash,
      worktreeId,
      reservedPath: plan.worktreePath,
      reservedBranch: plan.branch,
      requestedBaseRef: plan.requestedBaseRef,
      resolvedBaseCommit: plan.resolvedBaseCommit,
      materializationPlanJson: JSON.stringify(plan),
      now: this.now(),
    }
    const reservation = request.owner.kind === 'kanban-card'
      ? this.options.store.reserveKanbanOwner({
          ...reservationInput,
          owner: request.owner,
          projectPath: repository.projectPath,
        })
      : this.options.store.reserve(reservationInput)
    if (reservation.kind === 'owner_conflict') {
      throw new WorktreeCreationOwnerConflictError(
        this.kanbanOwnerConflictMessage(
          request.owner.kind === 'kanban-card' ? request.owner.cardId : '',
          reservation.reason,
        ),
      )
    }
    if (reservation.kind === 'conflict') throw new WorktreeCreationConflictError(request.creationId)
    if (reservation.kind === 'duplicate') return this.snapshot(reservation.record)
    this.publish(reservation.record)

    const step = await this.repositoryMutations.run(repository.repositoryId, async () => {
      const materializing = this.options.store.transition({
        ...key,
        expectedRevision: reservation.record.revision,
        phase: 'materializing',
        status: 'pending',
        now: this.now(),
      })
      if (materializing.kind !== 'updated') {
        if (materializing.kind === 'stale') return this.snapshot(materializing.record)
        throw new Error('Worktree creation reservation disappeared before materialization.')
      }
      this.publish(materializing.record)

      return this.materializeAndContinue(request, repository, plan, materializing.record)
    })
    return this.completeStep(step)
  }

  private async materializeAndContinue(
    request: WorktreeCreationRequest,
    repository: ResolvedGitRepository,
    plan: WorktreeMaterializationPlan,
    materializing: WorktreeCreationRecord,
  ): Promise<WorktreeCreationStep> {
    const key = { machineId: materializing.machineId, creationId: materializing.creationId }
    let forkStage: ForkWorktreeOwnerStage | undefined
    if (request.owner.kind === 'fork') {
      try {
        forkStage = await this.options.forkOwner!.prepare({
          request: request as ForkWorktreeCreationRequest,
          plan,
        })
      } catch (error) {
        log.warn('fork preparation failed before Git materialization', {
          machineId: materializing.machineId,
          creationId: materializing.creationId,
          error: this.errorMessage(error),
        })
        return this.rollBackReservation(materializing, this.compensatedError(materializing, error))
      }
    }
    const materialized = await this.options.git.materialize(plan)
    if (materialized.kind !== 'completed') {
      if (materialized.kind === 'outcome_unknown') {
        const inspection = await this.options.git.inspectMaterialization(plan)
        if (inspection.kind === 'exact' && inspection.headCommit === plan.resolvedBaseCommit) {
          return this.configureAndLink(request, repository, plan, materializing, forkStage)
        }
        if (inspection.kind === 'branch_only' && inspection.headCommit === plan.resolvedBaseCommit) {
          return request.owner.kind === 'fork' && forkStage
            ? this.compensateFork(plan, materializing, forkStage)
            : this.compensate(plan, materializing)
        }
        if (inspection.kind !== 'absent') return this.cleanupRequired(materializing)
        const failed = this.options.store.transition({
          ...key,
          expectedRevision: materializing.revision,
          phase: 'materializing',
          status: 'failed',
          now: this.now(),
        })
        if (failed.kind === 'updated') {
          this.publish(failed.record)
          return this.snapshot(failed.record)
        }
        return this.snapshot(failed.kind === 'stale' ? failed.record : materializing)
      }
      const failed = this.options.store.transition({
        ...key,
        expectedRevision: materializing.revision,
        phase: 'materializing',
        status: 'failed',
        now: this.now(),
      })
      if (failed.kind === 'updated') this.publish(failed.record)
      return this.snapshot(failed.kind === 'updated' ? failed.record : materializing)
    }
    if (materialized.headCommit !== plan.resolvedBaseCommit) {
      await this.options.git.inspectMaterialization(plan)
      return this.cleanupRequired(materializing)
    }

    return this.configureAndLink(request, repository, plan, materializing, forkStage)
  }

  private async configureAndLink(
    request: WorktreeCreationRequest,
    repository: ResolvedGitRepository,
    plan: WorktreeMaterializationPlan,
    materializing: WorktreeCreationRecord,
    preparedForkStage?: ForkWorktreeOwnerStage,
  ): Promise<WorktreeCreationStep> {
    const key = { machineId: materializing.machineId, creationId: materializing.creationId }
    let beforeLink = materializing
    if (request.checkout.sparseCheckout) {
      const configuring = this.options.store.transition({
        ...key,
        expectedRevision: beforeLink.revision,
        phase: 'configuring',
        status: 'pending',
        now: this.now(),
      })
      if (configuring.kind !== 'updated') throw new Error('Worktree creation changed before sparse checkout.')
      this.publish(configuring.record)
      try {
        const receipt = await this.options.git.configureSparse(
          plan,
          request.checkout.sparseCheckout.directories,
        )
        const configured = this.options.store.updateProgress({
          ...key,
          expectedRevision: configuring.record.revision,
          phase: 'configuring',
          status: 'pending',
          sparseReceiptJson: JSON.stringify({
            ...receipt,
            ...(request.checkout.sparseCheckout.presetId
              ? { presetId: request.checkout.sparseCheckout.presetId }
              : {}),
          }),
          now: this.now(),
        })
        if (configured.kind !== 'updated') {
          if (configured.kind === 'stale') return this.snapshot(configured.record)
          throw new Error('Worktree creation disappeared after sparse checkout.')
        }
        this.publish(configured.record)
        beforeLink = configured.record
      } catch (error) {
        const failed = this.options.store.updateProgress({
          ...key,
          expectedRevision: configuring.record.revision,
          phase: 'configuring',
          status: 'pending',
          sparseReceiptJson: JSON.stringify({
            mode: 'cone',
            directories: request.checkout.sparseCheckout.directories,
            ...(request.checkout.sparseCheckout.presetId
              ? { presetId: request.checkout.sparseCheckout.presetId }
              : {}),
            status: 'failed',
          }),
          now: this.now(),
        })
        return this.compensate(
          plan,
          failed.kind === 'updated' ? failed.record : configuring.record,
          error,
        )
      }
    }

    const linking = this.options.store.transition({
      ...key,
      expectedRevision: beforeLink.revision,
      phase: 'linking',
      status: 'pending',
      now: this.now(),
    })
    if (linking.kind !== 'updated') {
      if (linking.kind === 'stale') return this.snapshot(linking.record)
      throw new Error('Worktree creation disappeared before owner linking.')
    }
    this.publish(linking.record)

    let linked: ReturnType<SqliteWorktreeCreationStore['commitConversationOwner']>
    let forkStage = preparedForkStage
    try {
      const worktree = {
        id: linking.record.worktreeId ?? this.createWorktreeId(),
        repositoryId: repository.repositoryId,
        projectPath: repository.projectPath,
        worktreePath: plan.worktreePath,
        branch: plan.branch,
        requestedBaseRef: plan.requestedBaseRef,
        resolvedBaseCommit: plan.resolvedBaseCommit,
      }
      if (request.owner.kind === 'fork') {
        forkStage ??= await this.options.forkOwner!.prepare({
          request: request as ForkWorktreeCreationRequest,
          plan,
        })
        await this.options.forkOwner!.publish(forkStage)
        linked = await this.options.forkOwner!.commit({
          request: request as ForkWorktreeCreationRequest,
          stage: forkStage,
          ...key,
          expectedRevision: linking.record.revision,
          worktree,
          now: this.now(),
        })
      } else linked = request.owner.kind === 'kanban-card'
        ? this.options.store.commitKanbanOwner({
            ...key,
            expectedRevision: linking.record.revision,
            worktree,
            cardId: request.owner.cardId,
            ...(request.launch?.initialAgent ? {
              conversation: {
                id: this.launchConversationId(request),
                agentType: request.launch.initialAgent.provider,
              },
            } : {}),
            now: this.now(),
          })
        : this.options.store.commitConversationOwner({
            ...key,
            expectedRevision: linking.record.revision,
            worktree,
            conversation: {
              id: request.owner.conversationId,
              projectPath: repository.projectPath,
              agentType: request.owner.agentType,
              title: request.owner.title ?? 'New conversation',
            },
            now: this.now(),
          })
    } catch (error) {
      if (request.owner.kind === 'fork' && forkStage) {
        return this.compensateFork(plan, linking.record, forkStage, error)
      }
      return this.compensate(plan, linking.record, error)
    }
    if (linked.kind !== 'committed') {
      if (linked.kind === 'stale') return this.snapshot(linked.record)
      throw new Error('Worktree creation disappeared while linking its owner.')
    }
    this.publish(linked.record)

    if (request.setup.policy !== 'skip') {
      return () => this.provisionSetup(request, plan, linked.record)
    }

    if (request.launch) {
      return () => this.provisionStartup(request, linked.record)
    }

    const ready = this.options.store.transition({
      ...key,
      expectedRevision: linked.record.revision,
      phase: 'ready',
      status: 'ready',
      now: this.now(),
    })
    if (ready.kind !== 'updated') {
      if (ready.kind === 'stale') return this.snapshot(ready.record)
      throw new Error('Worktree creation disappeared before becoming ready.')
    }
    this.publish(ready.record)
    return this.snapshot(ready.record)
  }

  private async provisionSetup(
    request: WorktreeCreationRequest,
    plan: WorktreeMaterializationPlan,
    linked: WorktreeCreationRecord,
    forcedPolicy?: 'run',
    approvedCommandFingerprint?: string,
  ): Promise<WorktreeCreationSnapshot> {
    const key = { machineId: linked.machineId, creationId: linked.creationId }
    let config: Awaited<ReturnType<NonNullable<WorktreeCreationServiceOptions['setupConfig']>['load']>>
    try {
      config = await this.options.setupConfig?.load(request.repository.projectPath)
    } catch (error) {
      const failed = this.options.store.updateProgress({
        ...key,
        expectedRevision: linked.revision,
        phase: 'provisioning',
        status: 'cleanup_required',
        errorJson: JSON.stringify({
          code: 'setup_config_invalid',
          phase: 'provisioning',
          message: error instanceof Error ? error.message : 'The repository setup configuration is invalid.',
          retryable: false,
        }),
        now: this.now(),
      })
      if (failed.kind === 'updated') {
        this.publish(failed.record)
        return this.snapshot(failed.record)
      }
      if (failed.kind === 'stale') return this.snapshot(failed.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
    }
    const resolution = resolveWorktreeSetup(forcedPolicy ?? request.setup.policy, config)
    const commandFingerprint = resolution.command
      ? createHash('sha256').update(resolution.command).digest('hex')
      : undefined
    if (
      forcedPolicy === 'run'
      && (!approvedCommandFingerprint || approvedCommandFingerprint !== commandFingerprint)
    ) {
      const refreshed = this.options.store.updateProgress({
        ...key,
        expectedRevision: linked.revision,
        phase: 'awaiting_setup_decision',
        status: 'pending',
        setupReceiptJson: JSON.stringify({
          requestedPolicy: request.setup.policy,
          resolvedPolicy: 'ask',
          status: 'awaiting_decision',
          ...(resolution.command ? {
            commandSource: 'launch-config',
            commandFingerprint,
          } : {}),
        } satisfies WorktreeSetupReceipt),
        now: this.now(),
      })
      if (refreshed.kind !== 'updated') {
        if (refreshed.kind === 'stale') return this.snapshot(refreshed.record)
        throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
      }
      this.publish(refreshed.record)
      return this.snapshot(refreshed.record)
    }
    if (resolution.action === 'await_decision') {
      const paused = this.options.store.updateProgress({
        ...key,
        expectedRevision: linked.revision,
        phase: 'awaiting_setup_decision',
        status: 'pending',
        setupReceiptJson: JSON.stringify({
          ...resolution.receipt,
          ...(commandFingerprint ? { commandFingerprint } : {}),
        }),
        now: this.now(),
      })
      if (paused.kind !== 'updated') {
        if (paused.kind === 'stale') return this.snapshot(paused.record)
        throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
      }
      this.publish(paused.record)
      return this.snapshot(paused.record)
    }

    if (resolution.action !== 'run') {
      const resolved = this.options.store.updateProgress({
        ...key,
        expectedRevision: linked.revision,
        phase: 'provisioning',
        status: 'pending',
        setupReceiptJson: JSON.stringify(resolution.receipt),
        now: this.now(),
      })
      if (resolved.kind !== 'updated') {
        if (resolved.kind === 'stale') return this.snapshot(resolved.record)
        throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
      }
      this.publish(resolved.record)
      return this.finishAfterSetup(request, resolved.record)
    }

    if (
      resolution.startupPolicy === 'start-immediately'
      && request.launch
    ) {
      return this.provisionSetupAndStartup(request, plan, linked, resolution.command ?? '', resolution.receipt)
    }

    const startedAt = this.now()
    const runningReceipt: WorktreeSetupReceipt = {
      ...resolution.receipt,
      status: 'running',
      commandFingerprint: createHash('sha256').update(resolution.command ?? '').digest('hex'),
      startedAt,
    }
    const running = this.options.store.updateProgress({
      ...key,
      expectedRevision: linked.revision,
      phase: 'provisioning',
      status: 'pending',
      externalBoundary: 'setup',
      setupReceiptJson: JSON.stringify(runningReceipt),
      now: startedAt,
    })
    if (running.kind !== 'updated') {
      if (running.kind === 'stale') return this.snapshot(running.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
    }
    this.publish(running.record)

    const outcome = resolution.command
      ? await this.runSetupSafely({
          creationId: request.creationId,
          cwd: plan.worktreePath,
          command: resolution.command,
        })
      : { kind: 'failed' as const }
    const finishedAt = this.now()
    const status = outcome.kind === 'succeeded'
      ? 'succeeded'
      : outcome.kind === 'failed' ? 'failed' : 'ambiguous'
    const receipt: WorktreeSetupReceipt = {
      ...runningReceipt,
      status,
      finishedAt,
      ...('exitCode' in outcome && outcome.exitCode !== undefined
        ? { exitCode: outcome.exitCode }
        : {}),
    }
    const completed = this.options.store.updateProgress({
      ...key,
      expectedRevision: running.record.revision,
      phase: 'provisioning',
      status: outcome.kind === 'succeeded' ? 'pending' : 'cleanup_required',
      setupReceiptJson: JSON.stringify(receipt),
      ...(outcome.kind === 'succeeded' ? {} : {
        errorJson: JSON.stringify({
          code: outcome.kind === 'failed' ? 'setup_failed' : 'setup_outcome_unknown',
          phase: 'provisioning',
          message: outcome.kind === 'failed'
            ? 'Setup failed after it may have modified the worktree.'
            : 'Setup delivery is ambiguous; the worktree was retained.',
          retryable: false,
        }),
      }),
      now: finishedAt,
    })
    if (completed.kind !== 'updated') {
      if (completed.kind === 'stale') return this.snapshot(completed.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
    }
    this.publish(completed.record)
    return outcome.kind === 'succeeded'
      ? this.finishAfterSetup(request, completed.record)
      : this.snapshot(completed.record)
  }

  private async provisionSetupAndStartup(
    request: WorktreeCreationRequest,
    plan: WorktreeMaterializationPlan,
    linked: WorktreeCreationRecord,
    command: string,
    pendingSetupReceipt: WorktreeSetupReceipt,
  ): Promise<WorktreeCreationSnapshot> {
    if (!request.launch) throw new WorktreeCreationValidationError('Concurrent startup requires a launch intent.')
    const key = { machineId: linked.machineId, creationId: linked.creationId }
    const startedAt = this.now()
    const initialPromptOrigin = `${request.creationId}:initial-prompt`
    const setupRunning: WorktreeSetupReceipt = {
      ...pendingSetupReceipt,
      status: 'running',
      commandFingerprint: createHash('sha256').update(command).digest('hex'),
      startedAt,
    }
    const startupRunning: WorktreeStartupReceipt = {
      status: 'running',
      terminalIds: [],
      initialPromptOrigin,
    }
    const running = this.options.store.updateProgress({
      ...key,
      expectedRevision: linked.revision,
      phase: 'provisioning',
      status: 'pending',
      externalBoundary: 'setup+startup',
      setupReceiptJson: JSON.stringify(setupRunning),
      startupReceiptJson: JSON.stringify(startupRunning),
      clearError: true,
      now: startedAt,
    })
    if (running.kind !== 'updated') {
      if (running.kind === 'stale') return this.snapshot(running.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
    }
    this.publish(running.record)

    const setupPromise = this.options.setupRunner
      ? this.runSetupSafely({ creationId: request.creationId, cwd: plan.worktreePath, command })
      : Promise.resolve({ kind: 'failed' as const })
    const startupPromise = this.options.startupLauncher
      ? this.launchStartupSafely({
          creationId: request.creationId,
          projectPath: request.repository.projectPath,
          worktreePath: linked.reservedPath ?? plan.worktreePath,
          branch: linked.reservedBranch ?? plan.branch,
          conversationId: this.launchConversationId(request),
          initialPromptOrigin,
          launch: request.launch,
        })
      : Promise.resolve({ status: 'failed' as const, terminalIds: [] })
    const [setupOutcome, startupReceipt] = await Promise.all([setupPromise, startupPromise])
    const finishedAt = this.now()
    const setupStatus = setupOutcome.kind === 'succeeded'
      ? 'succeeded'
      : setupOutcome.kind === 'failed' ? 'failed' : 'ambiguous'
    const setupReceipt: WorktreeSetupReceipt = {
      ...setupRunning,
      status: setupStatus,
      finishedAt,
      ...('exitCode' in setupOutcome && setupOutcome.exitCode !== undefined
        ? { exitCode: setupOutcome.exitCode }
        : {}),
    }
    const succeeded = setupOutcome.kind === 'succeeded' && startupReceipt.status === 'succeeded'
    const error = setupOutcome.kind !== 'succeeded'
      ? {
          code: setupOutcome.kind === 'failed' ? 'setup_failed' : 'setup_outcome_unknown',
          phase: 'provisioning' as const,
          message: setupOutcome.kind === 'failed'
            ? 'Setup failed after it may have modified the worktree.'
            : 'Setup delivery is ambiguous; the worktree was retained.',
          retryable: false,
        }
      : startupReceipt.status !== 'succeeded'
        ? {
            code: startupReceipt.status === 'ambiguous' ? 'startup_outcome_unknown' : 'startup_failed',
            phase: 'provisioning' as const,
            message: startupReceipt.status === 'ambiguous'
              ? 'Workspace startup is ambiguous; the worktree was retained.'
              : 'The worktree was created, but the conversation was not started.',
            retryable: startupReceipt.status === 'ambiguous',
          }
        : undefined
    const completed = this.options.store.updateProgress({
      ...key,
      expectedRevision: running.record.revision,
      phase: succeeded ? 'ready' : 'provisioning',
      status: succeeded ? 'ready' : 'cleanup_required',
      setupReceiptJson: JSON.stringify(setupReceipt),
      startupReceiptJson: JSON.stringify(startupReceipt),
      ...(error ? { errorJson: JSON.stringify(error) } : { clearError: true }),
      now: finishedAt,
    })
    if (completed.kind !== 'updated') {
      if (completed.kind === 'stale') return this.snapshot(completed.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${linked.creationId}.`)
    }
    this.publish(completed.record)
    return this.snapshot(completed.record)
  }

  private async finishAfterSetup(
    request: WorktreeCreationRequest,
    record: WorktreeCreationRecord,
  ): Promise<WorktreeCreationSnapshot> {
    if (request.launch) {
      return this.provisionStartup(request, record)
    }
    const ready = this.options.store.transition({
      machineId: record.machineId,
      creationId: record.creationId,
      expectedRevision: record.revision,
      phase: 'ready',
      status: 'ready',
      now: this.now(),
    })
    if (ready.kind === 'updated') {
      this.publish(ready.record)
      return this.snapshot(ready.record)
    }
    if (ready.kind === 'stale') return this.snapshot(ready.record)
    throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${record.creationId}.`)
  }

  private async provisionStartup(
    request: WorktreeCreationRequest,
    record: WorktreeCreationRecord,
  ): Promise<WorktreeCreationSnapshot> {
    if (!request.launch) return this.snapshot(record)
    if (!record.reservedPath || !record.reservedBranch) {
      const error: WorktreeCreationError = {
        code: 'startup_identity_missing',
        phase: 'provisioning',
        message: 'Workspace startup was refused because the durable worktree path or branch is missing.',
        retryable: false,
      }
      log.warn('worktree startup refused before external boundary', {
        machineId: record.machineId,
        creationId: record.creationId,
        missingPath: !record.reservedPath,
        missingBranch: !record.reservedBranch,
      })
      return this.cleanupRequired(record, error)
    }
    const key = { machineId: record.machineId, creationId: record.creationId }
    const initialPromptOrigin = `${request.creationId}:initial-prompt`
    const runningReceipt: WorktreeStartupReceipt = {
      status: 'running',
      terminalIds: [],
      initialPromptOrigin,
    }
    const running = this.options.store.updateProgress({
      ...key,
      expectedRevision: record.revision,
      phase: 'provisioning',
      status: 'pending',
      externalBoundary: 'startup',
      startupReceiptJson: JSON.stringify(runningReceipt),
      clearError: true,
      now: this.now(),
    })
    if (running.kind !== 'updated') {
      if (running.kind === 'stale') return this.snapshot(running.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${record.creationId}.`)
    }
    this.publish(running.record)

    const receipt = this.options.startupLauncher
      ? await this.launchStartupSafely({
          creationId: request.creationId,
          projectPath: request.repository.projectPath,
          worktreePath: record.reservedPath,
          branch: record.reservedBranch,
          conversationId: this.launchConversationId(request),
          initialPromptOrigin,
          launch: request.launch,
        })
      : { status: 'failed' as const, terminalIds: [] }
    const succeeded = receipt.status === 'succeeded'
    const completed = this.options.store.updateProgress({
      ...key,
      expectedRevision: running.record.revision,
      phase: succeeded ? 'ready' : 'provisioning',
      status: succeeded ? 'ready' : 'cleanup_required',
      startupReceiptJson: JSON.stringify(receipt),
      ...(succeeded ? {} : {
        errorJson: JSON.stringify({
          code: receipt.status === 'ambiguous' ? 'startup_outcome_unknown' : 'startup_failed',
          phase: 'provisioning',
          message: receipt.status === 'ambiguous'
            ? 'Workspace startup is ambiguous; the worktree was retained.'
            : 'The worktree was created, but the conversation was not started.',
          retryable: receipt.status === 'ambiguous',
        }),
      }),
      now: this.now(),
    })
    if (completed.kind !== 'updated') {
      if (completed.kind === 'stale') return this.snapshot(completed.record)
      throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${record.creationId}.`)
    }
    this.publish(completed.record)
    return this.snapshot(completed.record)
  }

  private async recover(record: WorktreeCreationRecord): Promise<void> {
    if (!record.materializationPlanJson) {
      await this.markCleanupRequired(record)
      return
    }
    const request = JSON.parse(record.requestJson) as WorktreeCreationRequest
    const plan = JSON.parse(record.materializationPlanJson) as WorktreeMaterializationPlan
    const continuation = await this.repositoryMutations.run(plan.repository.repositoryId, () => (
      this.recoverWithRepositoryLock(record, request, plan)
    ))
    if (continuation) await continuation()
  }

  private recoverOnce(record: WorktreeCreationRecord): Promise<void> {
    const key = `${record.machineId}\u0000${record.creationId}`
    const running = this.recoveryInFlight.get(key)
    if (running) return running
    const promise = this.recover(record)
    this.recoveryInFlight.set(key, promise)
    void promise.finally(() => {
      if (this.recoveryInFlight.get(key) === promise) this.recoveryInFlight.delete(key)
    }).catch(() => {})
    return promise
  }

  private async recoverWithRepositoryLock(
    record: WorktreeCreationRecord,
    request: WorktreeCreationRequest,
    plan: WorktreeMaterializationPlan,
  ): Promise<WorktreeCreationContinuation | void> {
    const key = { machineId: record.machineId, creationId: record.creationId }

    if (record.externalBoundary === 'rollback_started') {
      const inspection = await this.options.git.inspectMaterialization(plan)
      if (request.owner.kind === 'fork') {
        // The provider artifact may have crossed its own external boundary.
        // Never recreate Git state while that outcome is unknown.
        await this.markCleanupRequired(record)
        return
      }
      if (inspection.kind === 'absent') {
        this.rollBackReservation(record)
        return
      }
      if (
        inspection.kind === 'mismatch'
        || (inspection.kind === 'exact' && inspection.headCommit !== plan.resolvedBaseCommit)
        || (inspection.kind === 'branch_only' && inspection.headCommit !== plan.resolvedBaseCommit)
      ) {
        await this.markCleanupRequired(record)
        return
      }
      await this.compensate(plan, record)
      return
    }

    const ownerCommitted = request.owner.kind === 'kanban-card'
      ? this.options.store.isKanbanOwnerCommitted(key)
      : request.owner.kind === 'conversation'
        ? this.options.store.isConversationOwnerCommitted(key)
        : this.options.forkOwner?.isCommitted(key) ?? false
    if (record.phase === 'awaiting_setup_decision' && ownerCommitted) {
      return
    }
    if (record.phase === 'provisioning' && ownerCommitted) {
      const setupReceipt = record.setupReceiptJson
        ? JSON.parse(record.setupReceiptJson) as WorktreeSetupReceipt
        : undefined
      const startupReceipt = record.startupReceiptJson
        ? JSON.parse(record.startupReceiptJson) as WorktreeStartupReceipt
        : undefined

      if (setupReceipt?.status === 'running') {
        const interruptedReceipt: WorktreeSetupReceipt = {
          ...setupReceipt,
          status: 'ambiguous',
          finishedAt: this.now(),
        }
        const interrupted = this.options.store.updateProgress({
          ...key,
          expectedRevision: record.revision,
          phase: 'provisioning',
          status: 'cleanup_required',
          setupReceiptJson: JSON.stringify(interruptedReceipt),
          ...(startupReceipt?.status === 'running'
            ? {
                startupReceiptJson: JSON.stringify({
                  ...startupReceipt,
                  status: 'ambiguous',
                } satisfies WorktreeStartupReceipt),
              }
            : {}),
          errorJson: JSON.stringify({
            code: 'setup_interrupted',
            phase: 'provisioning',
            message: 'Setup was interrupted after it may have modified the worktree.',
            retryable: false,
          }),
          now: this.now(),
        })
        if (interrupted.kind === 'updated') this.publish(interrupted.record)
        return
      }

      if (startupReceipt?.status === 'running') {
        return () => this.provisionStartup(request, record)
      }

      if (setupReceipt?.status === 'succeeded' && request.launch) {
        return () => this.provisionStartup(request, record)
      }
      if (!setupReceipt && request.setup.policy !== 'skip') {
        return () => this.provisionSetup(request, plan, record)
      }
      if (!startupReceipt && request.launch) {
        return () => this.provisionStartup(request, record)
      }
      if (
        !request.launch
        && setupReceipt
        && (setupReceipt.status === 'succeeded'
          || setupReceipt.status === 'skipped'
          || setupReceipt.status === 'not_configured')
      ) {
        return () => this.finishAfterSetup(request, record)
      }
      return
    }
    if (record.phase === 'linking' && ownerCommitted) {
      if (request.setup.policy !== 'skip') {
        return () => this.provisionSetup(request, plan, record)
      }
      if (request.launch) {
        return () => this.provisionStartup(request, record)
      }
      const ready = this.options.store.transition({
        ...key,
        expectedRevision: record.revision,
        phase: 'ready',
        status: 'ready',
        now: this.now(),
      })
      if (ready.kind === 'updated') this.publish(ready.record)
      return
    }

    const inspection = await this.options.git.inspectMaterialization(plan)
    if (
      inspection.kind === 'mismatch'
      || (inspection.kind === 'exact' && inspection.headCommit !== plan.resolvedBaseCommit)
      || (inspection.kind === 'branch_only' && inspection.headCommit !== plan.resolvedBaseCommit)
    ) {
      await this.markCleanupRequired(record)
      return
    }

    if (inspection.kind === 'branch_only') {
      await this.compensate(plan, record)
      return
    }

    let materializing = record
    if (record.phase === 'pending') {
      const transition = this.options.store.transition({
        ...key,
        expectedRevision: record.revision,
        phase: 'materializing',
        status: 'pending',
        now: this.now(),
      })
      if (transition.kind !== 'updated') return
      materializing = transition.record
      this.publish(materializing)
    }

    if (inspection.kind === 'absent') {
      const step = await this.materializeAndContinue(request, plan.repository, plan, materializing)
      return typeof step === 'function' ? step : undefined
    }
    const step = await this.configureAndLink(request, plan.repository, plan, materializing)
    return typeof step === 'function' ? step : undefined
  }

  private async markCleanupRequired(record: WorktreeCreationRecord): Promise<void> {
    const result = this.options.store.transition({
      machineId: record.machineId,
      creationId: record.creationId,
      expectedRevision: record.revision,
      phase: record.phase,
      status: 'cleanup_required',
      now: this.now(),
    })
    if (result.kind === 'updated') this.publish(result.record)
  }

  private async compensate(
    plan: WorktreeMaterializationPlan,
    inputRecord: WorktreeCreationRecord,
    cause?: unknown,
  ): Promise<WorktreeCreationSnapshot> {
    const record = this.beginCompensation(inputRecord)
    let rollback: WorktreeRollbackResult
    try {
      rollback = await this.options.git.rollbackMaterialization(plan)
    } catch (rollbackError) {
      const error = this.rollbackError(record, cause, rollbackError)
      log.warn('worktree compensation failed', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        error: error.message,
      })
      return this.cleanupRequired(record, error)
    }
    if (rollback.kind === 'refused') {
      const error = this.rollbackError(record, cause, new Error(`Rollback refused: ${rollback.reason}.`), 'rollback_refused')
      log.warn('worktree compensation was refused', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        reason: rollback.reason,
        error: error.message,
      })
      return this.cleanupRequired(record, error)
    }
    if (cause !== undefined) {
      log.warn('worktree creation failure was compensated', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        error: this.errorMessage(cause),
      })
    }
    return this.rollBackReservation(
      record,
      cause === undefined ? undefined : this.compensatedError(record, cause),
    )
  }

  private async compensateFork(
    plan: WorktreeMaterializationPlan,
    inputRecord: WorktreeCreationRecord,
    stage: ForkWorktreeOwnerStage,
    cause?: unknown,
  ): Promise<WorktreeCreationSnapshot> {
    const record = this.beginCompensation(inputRecord)
    let artifactRemoved = true
    let artifactError: unknown
    try {
      await this.options.forkOwner!.compensate(stage)
    } catch (error) {
      artifactRemoved = false
      artifactError = error
    }
    let rollback: WorktreeRollbackResult
    try {
      rollback = await this.options.git.rollbackMaterialization(plan)
    } catch (rollbackFailure) {
      const error = this.rollbackError(record, cause, rollbackFailure, 'rollback_failed', artifactError)
      log.warn('fork worktree compensation failed', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        error: error.message,
      })
      return this.cleanupRequired(record, error)
    }
    if (!artifactRemoved || rollback.kind === 'refused') {
      const refusal = rollback.kind === 'refused'
        ? new Error(`Rollback refused: ${rollback.reason}.`)
        : undefined
      const error = this.rollbackError(
        record,
        cause,
        refusal,
        rollback.kind === 'refused' ? 'rollback_refused' : 'fork_compensation_failed',
        artifactError,
      )
      log.warn('fork worktree compensation requires cleanup', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        error: error.message,
      })
      return this.cleanupRequired(record, error)
    }
    if (cause !== undefined) {
      log.warn('fork worktree creation failure was compensated', {
        machineId: record.machineId,
        creationId: record.creationId,
        phase: record.phase,
        error: this.errorMessage(cause),
      })
    }
    return this.rollBackReservation(
      record,
      cause === undefined ? undefined : this.compensatedError(record, cause),
    )
  }

  private beginCompensation(record: WorktreeCreationRecord): WorktreeCreationRecord {
    if (record.externalBoundary === 'rollback_started') return record
    const started = this.options.store.updateProgress({
      machineId: record.machineId,
      creationId: record.creationId,
      expectedRevision: record.revision,
      phase: record.phase,
      status: 'pending',
      externalBoundary: 'rollback_started',
      now: this.now(),
    })
    if (started.kind === 'updated') {
      this.publish(started.record)
      return started.record
    }
    if (started.kind === 'stale' && started.record.externalBoundary === 'rollback_started') {
      return started.record
    }
    throw new WorktreeCreationUnsafeActionError('Worktree creation changed before rollback could be recorded.')
  }

  private rollBackReservation(
    record: WorktreeCreationRecord,
    error?: WorktreeCreationError,
  ): WorktreeCreationSnapshot {
    const result = this.options.store.updateProgress({
      machineId: record.machineId,
      creationId: record.creationId,
      expectedRevision: record.revision,
      phase: record.phase,
      status: 'rolled_back',
      ...(error ? { errorJson: JSON.stringify(error) } : {}),
      now: this.now(),
    })
    if (result.kind === 'updated') {
      this.publish(result.record)
      return this.snapshot(result.record)
    }
    if (result.kind === 'stale') return this.snapshot(result.record)
    throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${record.creationId}.`)
  }

  private cleanupRequired(
    record: WorktreeCreationRecord,
    error?: WorktreeCreationError,
  ): WorktreeCreationSnapshot {
    const result = this.options.store.updateProgress({
      machineId: record.machineId,
      creationId: record.creationId,
      expectedRevision: record.revision,
      phase: record.phase,
      status: 'cleanup_required',
      ...(error ? { errorJson: JSON.stringify(error) } : {}),
      now: this.now(),
    })
    if (result.kind === 'updated') {
      this.publish(result.record)
      return this.snapshot(result.record)
    }
    if (result.kind === 'stale') return this.snapshot(result.record)
    throw new WorktreeCreationNotFoundError(`Unknown worktree creation ${record.creationId}.`)
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Unknown worktree creation failure.'
  }

  private compensatedError(record: WorktreeCreationRecord, cause: unknown): WorktreeCreationError {
    return {
      code: 'creation_compensated',
      phase: record.phase,
      message: `Creation failed and its partial work was rolled back: ${this.errorMessage(cause)}`,
      retryable: true,
    }
  }

  private rollbackError(
    record: WorktreeCreationRecord,
    cause: unknown,
    rollbackFailure?: unknown,
    code = 'rollback_failed',
    ownerCompensationFailure?: unknown,
  ): WorktreeCreationError {
    const details = [
      `Creation failed: ${cause === undefined ? 'The operation could not continue.' : this.errorMessage(cause)}`,
      ...(ownerCompensationFailure === undefined
        ? []
        : [`Owner compensation failed: ${this.errorMessage(ownerCompensationFailure)}`]),
      ...(rollbackFailure === undefined
        ? []
        : [`Git rollback failed: ${this.errorMessage(rollbackFailure)}`]),
    ]
    return {
      code,
      phase: record.phase,
      message: details.join(' '),
      retryable: false,
    }
  }

  private publish(record: WorktreeCreationRecord): void {
    this.options.progressSink.publish({
      creationId: record.creationId,
      revision: record.revision,
      phase: record.phase,
      status: record.status,
      timestamp: record.updatedAt,
      recoveryActions: this.recoveryActions(record),
    })
  }

  private snapshot(record: WorktreeCreationRecord): WorktreeCreationSnapshot {
    const request = JSON.parse(record.requestJson) as WorktreeCreationRequest
    const canonicalProjectPath = record.materializationPlanJson
      ? (JSON.parse(record.materializationPlanJson) as WorktreeMaterializationPlan).repository.projectPath
      : request.repository.projectPath
    return {
      creationId: record.creationId,
      revision: record.revision,
      phase: record.phase,
      status: record.status,
      ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
      projectPath: canonicalProjectPath,
      ...(record.reservedPath ? { worktreePath: record.reservedPath } : {}),
      ...(record.reservedBranch ? { branch: record.reservedBranch } : {}),
      baseRef: record.requestedBaseRef ?? request.checkout.baseRef,
      owner: request.owner,
      purpose: request.purpose,
      provenance: request.provenance,
      ...(request.lineage ? { lineage: request.lineage } : {}),
      ...(record.sparseReceiptJson
        ? { sparseCheckoutReceipt: JSON.parse(record.sparseReceiptJson) }
        : {}),
      ...(record.setupReceiptJson
        ? { setupReceipt: JSON.parse(record.setupReceiptJson) }
        : {}),
      ...(record.startupReceiptJson
        ? { startupReceipt: JSON.parse(record.startupReceiptJson) }
        : {}),
      warnings: JSON.parse(record.warningsJson) as string[],
      ...(record.errorJson ? { error: JSON.parse(record.errorJson) } : {}),
      ...(record.recoveryJson
        ? { cleanupDisposition: (JSON.parse(record.recoveryJson) as { disposition: WorktreeCreationSnapshot['cleanupDisposition'] }).disposition }
        : {}),
      recoveryActions: this.recoveryActions(record),
      updatedAt: record.updatedAt,
    }
  }

  private recoveryActions(record: WorktreeCreationRecord): WorktreeCreationSnapshot['recoveryActions'] {
    const cleanupDisposition = record.recoveryJson
      ? (JSON.parse(record.recoveryJson) as { disposition?: string }).disposition
      : undefined
    if (cleanupDisposition === 'removed') return []
    if (cleanupDisposition === 'retained') {
      const request = JSON.parse(record.requestJson) as WorktreeCreationRequest
      return request.owner.kind === 'fork' ? [] : ['remove']
    }
    if (cleanupDisposition === 'removal_refused') {
      return record.status === 'ready' ? ['remove'] : ['retain']
    }
    if (record.status === 'cleanup_required') {
      const setupReceipt = record.setupReceiptJson
        ? JSON.parse(record.setupReceiptJson) as WorktreeSetupReceipt
        : undefined
      if (setupReceipt?.status === 'ambiguous') return ['retain']
      const startupReceipt = record.startupReceiptJson
        ? JSON.parse(record.startupReceiptJson) as WorktreeStartupReceipt
        : undefined
      if (startupReceipt?.status === 'ambiguous') return ['retry', 'retain']
      const request = JSON.parse(record.requestJson) as WorktreeCreationRequest
      return request.owner.kind === 'fork' ? ['retain'] : ['retain', 'remove']
    }
    if (record.status === 'failed') {
      const request = JSON.parse(record.requestJson) as WorktreeCreationRequest
      return request.owner.kind === 'conversation' && record.phase === 'materializing'
        ? ['retry', 'start_in_project']
        : ['retry']
    }
    if (
      record.status === 'rolled_back'
      && (record.phase === 'materializing' || record.phase === 'configuring' || record.phase === 'linking')
    ) return ['retry']
    if (record.status === 'pending' && record.phase === 'awaiting_setup_decision') {
      return ['choose_setup_run', 'choose_setup_skip']
    }
    if (record.status === 'pending' && record.phase === 'pending') return ['cancel']
    return []
  }
}

export async function createWorktreeCreationService(
  options: WorktreeCreationServiceOptions,
): Promise<WorktreeCreationService> {
  const service = new WorktreeCreationService(options)
  await service.recoverInterruptedCreations()
  return service
}

export function startWorktreeCreationService(
  options: WorktreeCreationServiceOptions,
): WorktreeCreationService {
  const service = new WorktreeCreationService(options)
  void service.recoverInterruptedCreations().catch((error) => {
    log.warn('background worktree creation recovery failed', error)
  })
  return service
}
