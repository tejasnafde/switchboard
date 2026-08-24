import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalizeForkConversationIdentity,
  canonicalizeForkConversationRequest,
  type ForkConversationOutcome,
  type ForkConversationRequest,
  type ForkConversationResult,
  type ForkResumeMode,
  type ForkWarning,
  type ResolvedForkAnchor,
} from '../../shared/conversation-fork'
import type { ChatMessage } from '../../shared/types'
import type { SqliteConversationForkStore } from '../db/conversation-fork'
import {
  resolveCanonicalForkAnchor,
  type CanonicalForkMessage,
} from './fork-anchor'
import { cloneForkMessages } from './fork-message-codec'
import type { ForkSourceExecution } from './fork-source'

interface LoadedForkSource {
  source: ForkSourceExecution
  history: CanonicalForkMessage[]
}

export interface PreparedForkSnapshot {
  version: 1
  conversationId: string
  source: ForkSourceExecution
  prefix: ChatMessage[]
  anchor: ResolvedForkAnchor
  git?: ForkSourceGitReceipt
}

export interface ForkSourceGitReceipt {
  canonicalProjectPath: string
  sourceCheckoutPath: string
  headSha: string
  statusDigest: string
  trackedChanges: number
  untrackedChanges: number
  omittedChangeSummary: string
}

export interface ProviderForkArtifactStage {
  id: string
  [key: string]: unknown
}

export interface PreparedProviderForkArtifact {
  resumeMode: ForkResumeMode
  sessionId: string | null
  pendingHandoffFrom: string | null
  nativeResume?: ForkConversationResult['nativeResume']
  warnings: ForkWarning[]
  stage?: ProviderForkArtifactStage
}

export interface ProviderForkArtifactPort {
  prepare(input: {
    request: ForkConversationRequest
    prepared: PreparedForkSnapshot
    targetCwd: string
  }): Promise<PreparedProviderForkArtifact>
  publish(stage: ProviderForkArtifactStage): Promise<void>
  compensate(stage: ProviderForkArtifactStage): Promise<void>
}

export interface ConversationForkWorktreePort {
  prepare(input: {
    request: ForkConversationRequest
    prepared: PreparedForkSnapshot
  }): Promise<PreparedForkSnapshot>
  create(input: {
    request: ForkConversationRequest
    prepared: PreparedForkSnapshot
  }): Promise<ForkConversationOutcome>
}

export interface ConversationForkCoordinatorDependencies {
  store: SqliteConversationForkStore
  loadSource(request: ForkConversationRequest): Promise<LoadedForkSource>
  ids?: {
    conversation(): string
    message(conversationId: string, index: number, source: ChatMessage): string
  }
  clock?: () => number
  providerArtifacts: ProviderForkArtifactPort
  worktrees?: ConversationForkWorktreePort
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function titleForFork(sourceTitle: string): string {
  return `${sourceTitle.replace(/ · fork(\/[^·]*)?$/, '').trim()} · fork`
}

function failure(
  requestId: string,
  code: Extract<ForkConversationOutcome, { kind: 'failed' }>['error']['code'],
  message: string,
  retryable: boolean,
): ForkConversationOutcome {
  return { kind: 'failed', requestId, error: { code, message, retryable } }
}

function parsePrepared(record: { preparedJson: string }): PreparedForkSnapshot {
  const prepared = JSON.parse(record.preparedJson) as PreparedForkSnapshot
  if (prepared.version !== 1 || !prepared.conversationId || !prepared.source || !prepared.anchor) {
    throw new Error('Fork operation contains an invalid prepared snapshot')
  }
  return prepared
}

export class ConversationForkCoordinator {
  private readonly ids: NonNullable<ConversationForkCoordinatorDependencies['ids']>
  private readonly clock: () => number

  constructor(private readonly deps: ConversationForkCoordinatorDependencies) {
    this.ids = deps.ids ?? {
      conversation: randomUUID,
      message: () => randomUUID(),
    }
    this.clock = deps.clock ?? Date.now
  }

  get(machineId: string, requestId: string): ForkConversationOutcome | null {
    const result = this.deps.store.getResult(machineId, requestId)
    return result ? { kind: 'completed', result } : null
  }

  async createOrGet(request: ForkConversationRequest): Promise<ForkConversationOutcome> {
    const machineId = request.machineId ?? 'local'
    const requestHash = sha256(canonicalizeForkConversationIdentity(request))
    let operation = this.deps.store.get(machineId, request.requestId)

    if (operation) {
      if (operation.requestHash !== requestHash) {
        return failure(
          request.requestId,
          'idempotency-conflict',
          'This request id is already bound to a different fork operation.',
          false,
        )
      }
      const completed = this.deps.store.getResult(machineId, request.requestId)
      if (completed) return { kind: 'completed', result: completed }
    }

    let prepared: PreparedForkSnapshot
    if (operation) {
      try {
        prepared = parsePrepared(operation)
      } catch (error) {
        return failure(request.requestId, 'persistence-failed', String(error), false)
      }
    } else {
      let loaded: LoadedForkSource
      try {
        loaded = await this.deps.loadSource(request)
      } catch (error) {
        return failure(request.requestId, 'source-not-found', String(error), false)
      }
      const anchor = resolveCanonicalForkAnchor(loaded.history, request.anchor)
      if (!anchor.ok) {
        return failure(request.requestId, 'anchor-conflict', anchor.conflict.message, false)
      }
      prepared = {
        version: 1,
        conversationId: this.ids.conversation(),
        source: loaded.source,
        prefix: anchor.prefix,
        anchor: anchor.resolved,
      }
      if (request.checkout.kind === 'new-worktree') {
        if (!this.deps.worktrees) {
          return failure(request.requestId, 'git-failed', 'Worktree creation is unavailable on this backend.', true)
        }
        try {
          prepared = await this.deps.worktrees.prepare({ request, prepared })
        } catch (error) {
          return failure(request.requestId, 'git-failed', String(error), true)
        }
      }
      const preparedJson = JSON.stringify(prepared)
      const reservation = this.deps.store.reserve({
        machineId,
        request,
        requestJson: canonicalizeForkConversationRequest(request),
        requestHash,
        preparedJson,
        preparedHash: sha256(preparedJson),
        now: this.clock(),
      })
      if (reservation.kind === 'conflict') {
        return failure(
          request.requestId,
          'idempotency-conflict',
          'This request id is already bound to a different fork operation.',
          false,
        )
      }
      operation = reservation.record
      const completed = this.deps.store.getResult(machineId, request.requestId)
      if (completed) return { kind: 'completed', result: completed }
      prepared = parsePrepared(operation)
    }

    if (request.checkout.kind !== 'shared-checkout') {
      return this.deps.worktrees
        ? this.deps.worktrees.create({ request, prepared })
        : failure(
            request.requestId,
            'git-failed',
            'Worktree creation is unavailable on this backend.',
            true,
          )
    }

    return this.commitPlainFork(request, operation.revision, prepared)
  }

  private async commitPlainFork(
    request: ForkConversationRequest,
    expectedRevision: number,
    prepared: PreparedForkSnapshot,
  ): Promise<ForkConversationOutcome> {
    let provider: PreparedProviderForkArtifact
    try {
      provider = await this.deps.providerArtifacts.prepare({
        request,
        prepared,
        targetCwd: prepared.source.sourceCheckoutPath,
      })
    } catch (error) {
      return failure(request.requestId, 'provider-artifact-failed', String(error), true)
    }

    let published = false
    try {
      if (provider.stage) {
        await this.deps.providerArtifacts.publish(provider.stage)
        published = true
      }

      const createdAt = this.clock()
      const conversation: ForkConversationResult['conversation'] = {
        id: prepared.conversationId,
        projectPath: prepared.source.projectPath,
        worktreePath: null,
        worktreeBranch: null,
        worktreeId: null,
        machineId: prepared.source.machineId,
        agentType: prepared.source.agentType,
        providerInstanceId: prepared.source.providerInstanceId,
        runtimeMode: prepared.source.runtimeMode,
        model: prepared.source.model,
        reasoningEffort: prepared.source.reasoningEffort,
        launchConfigName: prepared.source.launchConfigName,
        title: titleForFork(prepared.source.title),
        parentConversationId: prepared.source.conversationId,
        parentTitle: prepared.source.title,
        anchor: prepared.anchor,
        resumeMode: provider.resumeMode,
        createdAt,
      }
      const cloned = cloneForkMessages(
        conversation.id,
        prepared.prefix,
        (index, source) => this.ids.message(conversation.id, index, source),
      )
      const result: ForkConversationResult = {
        requestId: request.requestId,
        conversation,
        messages: cloned.messages,
        ...(provider.nativeResume ? { nativeResume: provider.nativeResume } : {}),
        warnings: [
          ...provider.warnings,
          ...cloned.warnings.map((warning) => ({
            code: warning.code,
            message: `Message ${warning.messageId} preserved unsupported fields: ${warning.fields.join(', ')}.`,
          })),
        ],
      }
      const committed = this.deps.store.commitCompleted({
        machineId: prepared.source.machineId,
        requestId: request.requestId,
        expectedRevision,
        conversation,
        sessionId: provider.sessionId,
        pendingHandoffFrom: provider.pendingHandoffFrom,
        messages: cloned.rows,
        result,
        worktreeCreationId: null,
        now: createdAt,
      })
      if (committed.kind === 'stale') {
        const replay = this.deps.store.getResult(prepared.source.machineId, request.requestId)
        return replay
          ? { kind: 'completed', result: replay }
          : failure(request.requestId, 'completion-unknown', 'Fork state changed while committing.', true)
      }
      return { kind: 'completed', result }
    } catch (error) {
      if (published && provider.stage) {
        try {
          await this.deps.providerArtifacts.compensate(provider.stage)
        } catch (cleanupError) {
          return {
            kind: 'failed',
            requestId: request.requestId,
            error: {
              code: 'cleanup-required',
              message: `${String(error)}; provider artifact cleanup failed: ${String(cleanupError)}`,
              retryable: true,
            },
            recovery: { cleanupSafe: true },
          }
        }
      }
      return failure(request.requestId, 'persistence-failed', String(error), true)
    }
  }
}
