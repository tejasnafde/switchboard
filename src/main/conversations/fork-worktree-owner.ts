import { createHash } from 'node:crypto'
import { slugifyForBranch } from '../../shared/branchSlug'
import type {
  ForkConversationOutcome,
  ForkConversationRequest,
  ForkConversationResult,
} from '../../shared/conversation-fork'
import type { ForkWorktreeCreationRequest } from '../worktree-creation/worktree-creation-service'
import type {
  ForkWorktreeOwnerCommitInput,
  ForkWorktreeOwnerPort,
  ForkWorktreeOwnerPrepareInput,
  ForkWorktreeOwnerStage,
  WorktreeCreationService,
} from '../worktree-creation/worktree-creation-service'
import type { WorktreeCreationRequest, WorktreeCreationSnapshot } from '../../shared/worktree-creation'
import { SqliteConversationForkStore } from '../db/conversation-fork'
import { SqliteWorktreeCreationStore } from '../db/worktree-creation'
import { cloneForkMessages, type ClonedForkMessages } from './fork-message-codec'
import type {
  ForkSourceGitReceipt,
  PreparedForkSnapshot,
  PreparedProviderForkArtifact,
  ProviderForkArtifactPort,
} from './conversation-fork-coordinator'

export interface ForkSourceGitInspector {
  inspect(sourceCheckoutPath: string): Promise<ForkSourceGitReceipt>
}

interface PreparedForkWorktreeStage extends ForkWorktreeOwnerStage {
  prepared: PreparedForkSnapshot
  provider: PreparedProviderForkArtifact
  cloned: ClonedForkMessages
}

function stageOf(stage: ForkWorktreeOwnerStage): PreparedForkWorktreeStage {
  if (!('prepared' in stage) || !('provider' in stage) || !('cloned' in stage)) {
    throw new Error('Fork worktree stage is invalid')
  }
  return stage as PreparedForkWorktreeStage
}

function titleForBranch(sourceTitle: string, branch: string): string {
  return `${sourceTitle.replace(/ · fork(\/[^·]*)?$/, '').trim()} · ${branch}`
}

export class ForkWorktreeOwnerAdapter implements ForkWorktreeOwnerPort {
  constructor(
    private readonly worktrees: SqliteWorktreeCreationStore,
    private readonly forks: SqliteConversationForkStore,
    private readonly providerArtifacts: ProviderForkArtifactPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async prepare(input: ForkWorktreeOwnerPrepareInput): Promise<PreparedForkWorktreeStage> {
    const owner = input.request.owner
    const operation = this.forks.get(input.request.repository.machineId, owner.requestId)
    if (!operation || operation.status !== 'pending') {
      throw new Error(`Fork operation ${owner.requestId} is unavailable for worktree preparation`)
    }
    const prepared = JSON.parse(operation.preparedJson) as PreparedForkSnapshot
    if (prepared.conversationId !== owner.conversationId
      || prepared.source.conversationId !== owner.parentConversationId) {
      throw new Error('Worktree owner does not match the frozen fork operation')
    }
    const provider = await this.providerArtifacts.prepare({
      request: JSON.parse(operation.requestJson) as ForkConversationRequest,
      prepared,
      targetCwd: input.plan.worktreePath,
    })
    const cloned = cloneForkMessages(
      prepared.conversationId,
      prepared.prefix,
      (index) => `${prepared.conversationId}:message:${index}`,
    )
    return {
      prepared,
      provider,
      cloned,
      ...(provider.stage && typeof provider.stage.path === 'string'
        ? { artifactPath: provider.stage.path }
        : {}),
    }
  }

  async publish(stage: ForkWorktreeOwnerStage): Promise<void> {
    const provider = stageOf(stage).provider
    if (provider.stage) await this.providerArtifacts.publish(provider.stage)
  }

  async commit(input: ForkWorktreeOwnerCommitInput) {
    const stage = stageOf(input.stage)
    const operation = this.forks.get(input.machineId, input.request.owner.requestId)
    if (!operation) throw new Error('Fork operation disappeared before worktree commit')
    const createdAt = this.clock()
    const conversation: ForkConversationResult['conversation'] = {
      id: stage.prepared.conversationId,
      projectPath: stage.prepared.source.projectPath,
      worktreePath: input.worktree.worktreePath,
      worktreeBranch: input.worktree.branch,
      worktreeId: input.worktree.id,
      machineId: stage.prepared.source.machineId,
      agentType: stage.prepared.source.agentType,
      providerInstanceId: stage.prepared.source.providerInstanceId,
      runtimeMode: stage.prepared.source.runtimeMode,
      model: stage.prepared.source.model,
      reasoningEffort: stage.prepared.source.reasoningEffort,
      launchConfigName: stage.prepared.source.launchConfigName,
      title: titleForBranch(stage.prepared.source.title, input.worktree.branch),
      parentConversationId: stage.prepared.source.conversationId,
      parentTitle: stage.prepared.source.title,
      anchor: stage.prepared.anchor,
      resumeMode: stage.provider.resumeMode,
      createdAt,
    }
    const result: ForkConversationResult = {
      requestId: input.request.owner.requestId,
      conversation,
      messages: stage.cloned.messages,
      ...(stage.provider.nativeResume ? { nativeResume: stage.provider.nativeResume } : {}),
      git: {
        baseSha: input.worktree.resolvedBaseCommit,
        path: input.worktree.worktreePath,
        branch: input.worktree.branch,
        sourceDirty: input.request.owner.sourceDirty,
        ...(input.request.owner.omittedChangeSummary
          ? { omittedChangeSummary: input.request.owner.omittedChangeSummary }
          : {}),
      },
      warnings: [
        ...stage.provider.warnings,
        ...stage.cloned.warnings.map((warning) => ({
          code: warning.code,
          message: `Message ${warning.messageId} preserved unsupported fields: ${warning.fields.join(', ')}.`,
        })),
      ],
    }
    return this.worktrees.commitForkOwner({
      machineId: input.machineId,
      creationId: input.creationId,
      expectedRevision: input.expectedRevision,
      worktree: input.worktree,
      fork: {
        machineId: input.machineId,
        requestId: input.request.owner.requestId,
        expectedRevision: operation.revision,
        conversation,
        sessionId: stage.provider.sessionId,
        pendingHandoffFrom: stage.provider.pendingHandoffFrom,
        messages: stage.cloned.rows,
        result,
        worktreeCreationId: input.creationId,
        now: createdAt,
      },
      now: createdAt,
    })
  }

  async compensate(stage: ForkWorktreeOwnerStage): Promise<void> {
    const provider = stageOf(stage).provider
    if (provider.stage) await this.providerArtifacts.compensate(provider.stage)
  }

  isCommitted(key: { machineId: string; creationId: string }): boolean {
    return this.worktrees.isForkOwnerCommitted(key)
  }
}

export class ConversationForkWorktreePort {
  constructor(
    private readonly service: WorktreeCreationService,
    private readonly forks: SqliteConversationForkStore,
    private readonly git: ForkSourceGitInspector,
  ) {}

  async prepare(input: {
    request: ForkConversationRequest
    prepared: PreparedForkSnapshot
  }): Promise<PreparedForkSnapshot> {
    return {
      ...input.prepared,
      git: await this.git.inspect(input.prepared.source.sourceCheckoutPath),
    }
  }

  async create(input: {
    request: ForkConversationRequest
    prepared: PreparedForkSnapshot
  }): Promise<ForkConversationOutcome> {
    const { request, prepared } = input
    if (!prepared.git) throw new Error('Fork operation is missing its frozen Git source receipt')
    const receipt = prepared.git
    const current = await this.git.inspect(prepared.source.sourceCheckoutPath)
    const confirmation = request.checkout.kind === 'new-worktree'
      ? request.checkout.dirtySourceConfirmed
      : undefined
    const sourceDirty = receipt.trackedChanges > 0 || receipt.untrackedChanges > 0
    if (sourceDirty && !confirmation) {
      return {
        kind: 'confirmation-required',
        requestId: request.requestId,
        dirtySource: receipt,
      }
    }
    const sourceChanged = current.headSha !== receipt.headSha || current.statusDigest !== receipt.statusDigest
    if (sourceChanged || (confirmation
      && (confirmation.headSha !== receipt.headSha || confirmation.statusDigest !== receipt.statusDigest))) {
      return {
        kind: 'failed',
        requestId: request.requestId,
        error: {
          code: 'dirty-source-changed',
          message: 'The source HEAD or working tree changed after confirmation.',
          retryable: true,
        },
      }
    }

    const worktreeRequest = this.buildRequest(request, prepared, receipt, sourceDirty)
    let snapshot: WorktreeCreationSnapshot
    try {
      snapshot = await this.service.createWorktreeTransaction(worktreeRequest)
    } catch (error) {
      return {
        kind: 'failed',
        requestId: request.requestId,
        error: { code: 'git-failed', message: String(error), retryable: true },
      }
    }
    const result = this.forks.getResult(prepared.source.machineId, request.requestId)
    if (result) return { kind: 'completed', result }
    const retained = snapshot.status === 'cleanup_required'
    return {
      kind: 'failed',
      requestId: request.requestId,
      error: {
        code: retained ? 'cleanup-required' : 'git-failed',
        message: snapshot.error?.message
          ?? `Worktree creation stopped at ${snapshot.phase}/${snapshot.status}.`,
        retryable: snapshot.error?.retryable ?? true,
      },
      ...(retained
        ? {
            recovery: {
              retainedPath: snapshot.worktreePath,
              retainedBranch: snapshot.branch,
              cleanupSafe: snapshot.recoveryActions.includes('remove'),
            },
          }
        : {}),
    }
  }

  private buildRequest(
    request: ForkConversationRequest,
    prepared: PreparedForkSnapshot,
    receipt: ForkSourceGitReceipt,
    sourceDirty: boolean,
  ): ForkWorktreeCreationRequest {
    const selected = prepared.prefix.at(-1)
    const seed = slugifyForBranch((selected?.content || prepared.source.title).slice(0, 80))
    return {
      schemaVersion: 1,
      creationId: request.requestId,
      repository: {
        projectPath: prepared.source.sourceCheckoutPath,
        machineId: prepared.source.machineId,
      },
      checkout: {
        baseRef: receipt.headSha,
        branch: { namespace: 'fork', seed },
        location: 'managed-in-repo',
      },
      owner: {
        kind: 'fork',
        requestId: request.requestId,
        conversationId: prepared.conversationId,
        parentConversationId: prepared.source.conversationId,
        sourceDirty,
        ...(sourceDirty ? { omittedChangeSummary: receipt.omittedChangeSummary } : {}),
      },
      purpose: 'fork',
      setup: { policy: 'skip' },
      lineage: {
        ...(prepared.source.sourceWorktreeId
          ? { parentWorktreeId: prepared.source.sourceWorktreeId }
          : {}),
        parentConversationId: prepared.source.conversationId,
        sourceMessageId: prepared.anchor.messageId,
      },
      provenance: {
        surface: request.provenance.surface === 'automation' ? 'desktop' : request.provenance.surface,
        machineId: prepared.source.machineId,
        requestedAt: request.provenance.requestedAt,
      },
    }
  }
}

export function statusDigest(status: string): string {
  return createHash('sha256').update(status).digest('hex')
}
