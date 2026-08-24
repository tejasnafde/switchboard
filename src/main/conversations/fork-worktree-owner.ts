import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assembleClaudeFork, truncateCodexJsonl } from '../agent/jsonl-truncate'
import { loadJsonlCached } from '../agent/jsonl-cache'
import {
  getConversationById,
  getMessagesForConversation,
  messageRowsToChatMessages,
} from '../db/database'
import { SqliteWorktreeCreationStore } from '../db/worktree-creation'
import { resolveProviderInstance } from '../db/providerInstances'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { defaultClaudeDir } from '../provider/claude-session-migrate'
import { slugifyForBranch } from '../../shared/branchSlug'
import type { ChatMessage } from '../../shared/types'
import type { WorktreeCreationSnapshot } from '../../shared/worktree-creation'
import type {
  ForkWorktreeCreationRequest,
  ForkWorktreeOwnerCommitInput,
  ForkWorktreeOwnerPort,
  ForkWorktreeOwnerPrepareInput,
  ForkWorktreeOwnerStage,
  WorktreeCreationService,
} from '../worktree-creation/worktree-creation-service'
import {
  findCodexRolloutForConversation,
  listClaudeFragmentPaths,
  resolveNativeForkIndex,
  type ForkInput,
  type ForkResult,
  type ForkWorktreeCreationResult,
} from './fork'
import { loadConversationHistory } from './history'

interface ForkArtifact {
  path: string
  content: string
}

interface PreparedForkStage extends ForkWorktreeOwnerStage {
  conversation: {
    id: string
    projectPath: string
    agentType: string
    sessionId: string | null
    title: string
    parentConversationId: string
    forkedAtMessageId: string
    worktreePath: string
    worktreeBranch: string
    pendingHandoffFrom: string | null
  }
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>
  artifact?: ForkArtifact
  resumable: boolean
}

function stageOf(stage: ForkWorktreeOwnerStage): PreparedForkStage {
  if (!('conversation' in stage) || !('messages' in stage)) {
    throw new Error('fork owner stage is invalid')
  }
  return stage as PreparedForkStage
}

function stripForSlug(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function stripForkSuffix(title: string): string {
  return title.replace(/ · fork(\/[^·]*)?$/, '').trim()
}

async function writeExactArtifact(artifact: ForkArtifact): Promise<void> {
  await mkdir(dirname(artifact.path), { recursive: true })
  try {
    await writeFile(artifact.path, artifact.content, { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(artifact.path, 'utf-8')
    if (existing !== artifact.content) {
      throw new Error(`fork transcript conflict at ${artifact.path}`)
    }
  }
}

async function prepareClaudeArtifact(
  request: ForkWorktreeCreationRequest,
  worktreePath: string,
  keptMessages: ChatMessage[],
): Promise<{ artifact?: ForkArtifact; resumable: boolean }> {
  const fragmentPaths = listClaudeFragmentPaths(request.owner.parentConversationId)
  if (fragmentPaths.length === 0) return { resumable: false }

  const fragments: string[] = []
  const nativeMessages: ChatMessage[] = []
  for (const path of fragmentPaths) {
    fragments.push(await readFile(path, 'utf-8'))
    const parsed = await loadJsonlCached(path, 'claude-code')
    if (parsed) nativeMessages.push(...parsed)
  }
  const nativeIndex = resolveNativeForkIndex(keptMessages, nativeMessages, keptMessages.length - 1)
  if (nativeIndex === null) return { resumable: false }
  const truncated = assembleClaudeFork(fragments, nativeIndex + 1, {
    newSessionId: request.owner.conversationId,
  })
  if (!truncated.anchorUuid || truncated.keptVisibleCount === 0) return { resumable: false }

  const projectDir = join(
    resolveProviderInstance('claude-code', null)?.oauthDir ?? defaultClaudeDir(),
    'projects',
    encodeClaudeProjectPath(worktreePath),
  )
  return {
    resumable: true,
    artifact: {
      path: join(projectDir, `${request.owner.conversationId}.jsonl`),
      content: truncated.newContent,
    },
  }
}

async function prepareCodexArtifact(
  request: ForkWorktreeCreationRequest,
  keptMessages: ChatMessage[],
): Promise<ForkArtifact | undefined> {
  const sourceFile = await findCodexRolloutForConversation(request.owner.parentConversationId)
  if (!sourceFile) return undefined
  const raw = await readFile(sourceFile, 'utf-8')
  const nativeMessages = await loadJsonlCached(sourceFile, 'codex') ?? []
  const nativeIndex = resolveNativeForkIndex(keptMessages, nativeMessages, keptMessages.length - 1)
  if (nativeIndex === null) return undefined
  const truncated = truncateCodexJsonl(raw, nativeIndex + 1)
  if (truncated.keptVisibleCount === 0) return undefined
  return {
    path: join(dirname(sourceFile), `rollout-fork-${request.owner.conversationId}.jsonl`),
    content: truncated.newContent,
  }
}

export class ForkWorktreeOwnerAdapter implements ForkWorktreeOwnerPort {
  constructor(private readonly store: SqliteWorktreeCreationStore) {}

  async prepare(input: ForkWorktreeOwnerPrepareInput): Promise<PreparedForkStage> {
    const source = getConversationById(input.request.owner.parentConversationId)
    if (!source) throw new Error(`fork: unknown source conversation ${input.request.owner.parentConversationId}`)
    if (source.project_path !== input.request.repository.projectPath) {
      throw new Error('fork: source conversation moved to a different project')
    }

    const sourceMessages = (await loadConversationHistory(source.id, source.project_path)).messages
    if (input.request.owner.upToIndex < 0 || input.request.owner.upToIndex >= sourceMessages.length) {
      throw new Error(`fork: boundary ${input.request.owner.upToIndex} is outside the source transcript`)
    }
    const keptMessages = sourceMessages.slice(0, input.request.owner.upToIndex + 1)
    const forkedAtMessageId = input.request.owner.forkedAtMessageId
      ?? `idx:${input.request.owner.upToIndex}`
    const title = `${stripForkSuffix(source.title)} · ${input.plan.branch}`

    let artifact: ForkArtifact | undefined
    let resumable = false
    if (source.agent_type === 'claude-code') {
      const prepared = await prepareClaudeArtifact(input.request, input.plan.worktreePath, keptMessages)
      artifact = prepared.artifact
      resumable = prepared.resumable
    } else if (source.agent_type === 'codex') {
      artifact = await prepareCodexArtifact(input.request, keptMessages)
    }

    return {
      ...(artifact ? { artifactPath: artifact.path, artifact } : {}),
      conversation: {
        id: input.request.owner.conversationId,
        projectPath: source.project_path,
        agentType: source.agent_type,
        sessionId: resumable ? input.request.owner.conversationId : null,
        title,
        parentConversationId: source.id,
        forkedAtMessageId,
        worktreePath: input.plan.worktreePath,
        worktreeBranch: input.plan.branch,
        pendingHandoffFrom: resumable ? null : source.agent_type,
      },
      messages: keptMessages.map((message, index) => ({
        id: `${input.request.owner.conversationId}:${index}`,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      })),
      resumable,
    }
  }

  async publish(stage: ForkWorktreeOwnerStage): Promise<void> {
    const artifact = stageOf(stage).artifact
    if (artifact) await writeExactArtifact(artifact)
  }

  async commit(input: ForkWorktreeOwnerCommitInput) {
    const stage = stageOf(input.stage)
    return this.store.commitForkOwner({
      machineId: input.machineId,
      creationId: input.creationId,
      expectedRevision: input.expectedRevision,
      worktree: input.worktree,
      conversation: stage.conversation,
      messages: stage.messages,
      now: input.now,
    })
  }

  async compensate(stage: ForkWorktreeOwnerStage): Promise<void> {
    const artifact = stageOf(stage).artifact
    if (!artifact) return
    try {
      await unlink(artifact.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  isCommitted(key: { machineId: string; creationId: string }): boolean {
    return this.store.isForkOwnerCommitted(key)
  }
}

export interface ForkWorktreeCoordinatorInput extends ForkInput {
  creationId?: string
  conversationId?: string
  machineId?: string
}

export function buildForkWorktreeRequest(args: {
  source: { id: string; projectPath: string; worktreeBranch?: string | null }
  selectedBody: string
  input: ForkWorktreeCoordinatorInput
  requestedAt: number
}): ForkWorktreeCreationRequest {
  const creationId = args.input.creationId ?? randomUUID()
  const conversationId = args.input.conversationId ?? creationId
  const machineId = args.input.machineId ?? 'local'
  return {
    schemaVersion: 1,
    creationId,
    repository: { projectPath: args.source.projectPath, machineId },
    checkout: {
      baseRef: args.source.worktreeBranch || 'HEAD',
      branch: { namespace: 'fork', seed: slugifyForBranch(stripForSlug(args.selectedBody)) },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'fork',
      conversationId,
      parentConversationId: args.source.id,
      ...(args.input.forkedAtMessageId
        ? { forkedAtMessageId: args.input.forkedAtMessageId }
        : {}),
      upToIndex: args.input.upToIndex,
    },
    purpose: 'fork',
    setup: { policy: 'skip' },
    lineage: {
      parentConversationId: args.source.id,
      ...(args.input.forkedAtMessageId
        ? { sourceMessageId: args.input.forkedAtMessageId }
        : {}),
    },
    provenance: { surface: 'desktop', machineId, requestedAt: args.requestedAt },
  }
}

export class ForkWorktreeCoordinator {
  constructor(
    private readonly service: WorktreeCreationService,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: ForkWorktreeCoordinatorInput): Promise<ForkWorktreeCreationResult> {
    const source = getConversationById(input.sourceConversationId)
    if (!source) throw new Error(`fork: unknown source conversation ${input.sourceConversationId}`)
    const sourceMessages = (await loadConversationHistory(source.id, source.project_path)).messages
    if (input.upToIndex < 0 || input.upToIndex >= sourceMessages.length) {
      throw new Error(`fork: upToIndex ${input.upToIndex} out of range for source ${source.id}`)
    }
    const selected = sourceMessages[input.upToIndex]
    const request = buildForkWorktreeRequest({
      source: {
        id: source.id,
        projectPath: source.project_path,
        worktreeBranch: source.worktree_branch,
      },
      selectedBody: selected.content,
      input,
      requestedAt: input.requestedAt ?? this.now(),
    })
    const snapshot = await this.service.createWorktreeTransaction(request)
    return this.resultFromSnapshot(snapshot, request.owner.conversationId)
  }

  private resultFromSnapshot(snapshot: WorktreeCreationSnapshot, conversationId: string): ForkWorktreeCreationResult {
    if (snapshot.status !== 'ready' || !snapshot.worktreePath || !snapshot.branch) {
      return { worktreeCreation: snapshot }
    }
    const conversation = getConversationById(conversationId)
    if (!conversation) throw new Error('fork owner commit completed without a conversation projection')
    const resumable = conversation.session_id === conversation.id
    return {
      conversation: {
        id: conversation.id,
        projectPath: conversation.project_path,
        agentType: conversation.agent_type,
        title: conversation.title,
        parentConversationId: conversation.parent_conversation_id ?? '',
        forkedAtMessageId: conversation.forked_at_message_id ?? '',
        createdAt: conversation.created_at,
      },
      resumeHint: resumable ? conversation.session_id : null,
      messages: messageRowsToChatMessages(getMessagesForConversation(conversation.id)),
      resumable,
      worktree: { path: snapshot.worktreePath, branch: snapshot.branch },
    }
  }
}
