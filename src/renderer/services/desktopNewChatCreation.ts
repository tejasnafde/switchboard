import type { RuntimeMode } from '../../shared/provider-events'
import type { AgentType, SessionSummary } from '../../shared/types'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
  WorktreeCreationRecoveryAction,
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../shared/worktree-creation'

export function shouldDismissDesktopWorktreeSnapshot(snapshot: WorktreeCreationSnapshot): boolean {
  if (snapshot.cleanupDisposition === 'removed') return true
  if (snapshot.status === 'cancelled' || snapshot.status === 'rolled_back') return true
  return snapshot.recoveryActions.length === 0
    && (snapshot.status === 'failed' || snapshot.status === 'cleanup_required')
    && snapshot.cleanupDisposition !== 'retained'
}

export function retainedWorktreeCreationKey(
  session: SessionSummary,
  machineId: string,
): GetWorktreeCreationRequest | null {
  if (
    !session.worktreeCreationId
    || session.worktreeRecovery?.status !== 'cleanup_required'
    || session.worktreeRecovery.cleanupDisposition !== 'retained'
  ) return null
  return { creationId: session.worktreeCreationId, machineId }
}

export async function retryDesktopWorktreeCreation<ReconcileResult, ActionResult>({
  snapshot,
  action,
  reconcile,
  act,
}: {
  snapshot: WorktreeCreationSnapshot
  action: WorktreeCreationRecoveryAction
  reconcile(): Promise<ReconcileResult>
  act(request: WorktreeCreationActionRequest): Promise<ActionResult>
}): Promise<ReconcileResult | ActionResult> {
  if (snapshot.revision === 0) {
    if (action !== 'retry') {
      throw new Error('Only retry is available before the backend records a worktree creation.')
    }
    return reconcile()
  }
  return act({
    creationId: snapshot.creationId,
    machineId: snapshot.provenance.machineId,
    expectedRevision: snapshot.revision,
    action,
  })
}

export interface DesktopNewChatIntent {
  projectPath: string
  machineId: string
  checkout: 'project' | 'worktree'
  agentType: Exclude<AgentType, 'terminal'>
  runtimeMode: RuntimeMode
}

export interface AuthoritativeDesktopSession {
  id: string
  type: Exclude<AgentType, 'terminal'>
  status: 'idle'
  projectPath: string
  machineId: string
  worktreeId: string
  worktreePath: string
  worktreeBranch: string
  title: string
  runtimeMode: RuntimeMode
  managedTerminalIds: string[]
}

export interface ParentCheckoutCreationIntent {
  creationId: string
  conversationId: string
  projectPath: string
  machineId: string
  agentType: Exclude<AgentType, 'terminal'>
  runtimeMode: RuntimeMode
  title: string
}

export interface DesktopNewChatState {
  status: 'idle' | 'submitting' | 'reconciling' | 'pending' | 'failed' | 'ready'
  creationId?: string
  conversationId?: string
  snapshot?: WorktreeCreationSnapshot
  detail?: string
  error?: string
}

export interface DesktopNewChatJournalEntry {
  intent: DesktopNewChatIntent
  request: WorktreeCreationRequest
}

export interface DesktopNewChatJournal {
  save(entry: DesktopNewChatJournalEntry): void
  remove(creationId: string): void
}

export interface DesktopNewChatCoordinatorOptions {
  worktrees: {
    create(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
    get(request: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
    onProgress(listener: (event: WorktreeCreationProgressEvent) => void): () => void
  }
  sessions: {
    addAuthoritative(session: AuthoritativeDesktopSession): void
  }
  parent: {
    create(intent: ParentCheckoutCreationIntent): Promise<{ conversationId: string }>
  }
  createId(): string
  now(): number
  journal?: DesktopNewChatJournal
  onStateChange?(state: DesktopNewChatState): void
}

export interface DesktopNewChatCoordinator {
  start(intent: DesktopNewChatIntent): Promise<DesktopNewChatState>
  restore(entry: DesktopNewChatJournalEntry): Promise<DesktopNewChatState>
  reconcile(): Promise<DesktopNewChatState>
  startInProject(): Promise<{ conversationId: string }>
  state(): DesktopNewChatState
  dismiss(): void
  dispose(): void
}

export function createDesktopNewChatCoordinator(
  options: DesktopNewChatCoordinatorOptions,
): DesktopNewChatCoordinator {
  let current: DesktopNewChatState = { status: 'idle' }
  let activeIntent: DesktopNewChatIntent | null = null
  let activeRequest: WorktreeCreationRequest | null = null
  let admittedConversationId: string | null = null
  const replaceState = (next: DesktopNewChatState): DesktopNewChatState => {
    current = next
    options.onStateChange?.(current)
    return current
  }

  const localFailureSnapshot = (
    request: WorktreeCreationRequest,
    error: unknown,
    definite: boolean,
  ): WorktreeCreationSnapshot => ({
    creationId: request.creationId,
    revision: 0,
    phase: 'pending',
    status: definite ? 'failed' : 'pending',
    projectPath: request.repository.projectPath,
    baseRef: request.checkout.baseRef,
    owner: request.owner,
    purpose: request.purpose,
    provenance: request.provenance,
    warnings: [],
    error: {
      code: definite ? 'submission_rejected' : 'submission_outcome_unknown',
      phase: 'pending',
      message: error instanceof Error ? error.message : 'Workspace creation could not be confirmed.',
      retryable: true,
    },
    recoveryActions: definite ? ['retry', 'start_in_project'] : ['retry'],
    updatedAt: options.now(),
  })

  const acceptSnapshot = (snapshot: WorktreeCreationSnapshot): DesktopNewChatState => {
    if (!activeRequest || snapshot.creationId !== activeRequest.creationId) return current
    if (shouldDismissDesktopWorktreeSnapshot(snapshot)) options.journal?.remove(snapshot.creationId)
    const base = {
      creationId: activeRequest.creationId,
      conversationId: activeRequest.owner.kind === 'conversation'
        ? activeRequest.owner.conversationId
        : undefined,
      snapshot,
    }
    if (snapshot.status === 'ready') {
      const owner = snapshot.owner
      if (
        owner.kind !== 'conversation' ||
        !snapshot.worktreeId ||
        !snapshot.worktreePath ||
        !snapshot.branch ||
        snapshot.startupReceipt?.status !== 'succeeded'
      ) {
        return replaceState({ ...base, status: 'pending', detail: 'Waiting for authoritative workspace startup.' })
      }
      if (admittedConversationId !== owner.conversationId) {
        admittedConversationId = owner.conversationId
        options.sessions.addAuthoritative({
          id: owner.conversationId,
          type: owner.agentType as Exclude<AgentType, 'terminal'>,
          status: 'idle',
          projectPath: snapshot.projectPath,
          machineId: snapshot.provenance.machineId,
          worktreeId: snapshot.worktreeId,
          worktreePath: snapshot.worktreePath,
          worktreeBranch: snapshot.branch,
          title: owner.title ?? 'New conversation',
          runtimeMode: activeRequest.launch?.initialAgent?.runtimeMode ?? 'sandbox',
          managedTerminalIds: snapshot.startupReceipt.terminalIds,
        })
      }
      options.journal?.remove(snapshot.creationId)
      return replaceState({ ...base, status: 'ready' })
    }
    if (snapshot.status === 'failed' || snapshot.status === 'rolled_back' || snapshot.status === 'cancelled') {
      return replaceState({
        ...base,
        status: 'failed',
        error: snapshot.error?.message ?? 'The worktree conversation was not started.',
      })
    }
    return replaceState({ ...base, status: 'pending' })
  }

  const unsubscribe = options.worktrees.onProgress((event) => {
    if (!activeRequest || event.creationId !== activeRequest.creationId) return
    if (current.snapshot && event.revision < current.snapshot.revision) return
    replaceState({
      ...current,
      detail: event.detail,
    })
  })

  return {
    async start(intent) {
      if (intent.checkout !== 'worktree') {
        activeIntent = intent
        const creationId = options.createId()
        const conversationId = options.createId()
        return options.parent.create({
          creationId,
          conversationId,
          projectPath: intent.projectPath,
          machineId: intent.machineId,
          agentType: intent.agentType,
          runtimeMode: intent.runtimeMode,
          title: 'New conversation',
        }).then((result) => {
          return replaceState({ status: 'ready', creationId, conversationId: result.conversationId })
        })
      }
      activeIntent = intent
      const creationId = options.createId()
      const conversationId = options.createId()
      activeRequest = {
        schemaVersion: 1,
        creationId,
        repository: {
          projectPath: intent.projectPath,
          machineId: intent.machineId,
        },
        checkout: {
          baseRef: 'HEAD',
          branch: { namespace: 'sb', seed: `thread-${conversationId}` },
          location: 'managed-user-data',
        },
        owner: {
          kind: 'conversation',
          conversationId,
          agentType: intent.agentType,
          title: 'New conversation',
        },
        purpose: 'new-chat',
        setup: { policy: 'inherit' },
        launch: {
          initialAgent: {
            provider: intent.agentType,
            runtimeMode: intent.runtimeMode,
          },
        },
        provenance: {
          surface: 'desktop',
          machineId: intent.machineId,
          requestedAt: options.now(),
        },
      }
      options.journal?.save({ intent, request: activeRequest })
      replaceState({ status: 'submitting', creationId, conversationId })
      try {
        return acceptSnapshot(await options.worktrees.create(activeRequest))
      } catch (error) {
        try {
          return acceptSnapshot(await options.worktrees.get({ creationId, machineId: intent.machineId }))
        } catch (reconcileError) {
          const definite = reconcileError instanceof Error
            && /unknown worktree creation/i.test(reconcileError.message)
          const snapshot = localFailureSnapshot(activeRequest, error, definite)
          return replaceState({
            status: definite ? 'failed' : 'reconciling',
            creationId,
            conversationId,
            snapshot,
            detail: definite ? undefined : 'Reconnecting to confirm workspace creation.',
            error: definite ? snapshot.error?.message : undefined,
          })
        }
      }
    },

    async restore(entry) {
      activeIntent = entry.intent
      activeRequest = entry.request
      replaceState({
        status: 'reconciling',
        creationId: entry.request.creationId,
        conversationId: entry.request.owner.kind === 'conversation'
          ? entry.request.owner.conversationId
          : undefined,
        detail: 'Reconnecting to confirm workspace creation.',
      })
      return this.reconcile()
    },

    async reconcile() {
      if (!activeRequest) throw new Error('No worktree creation is available to reconcile.')
      replaceState({ ...current, status: 'reconciling' })
      try {
        return acceptSnapshot(await options.worktrees.get({
          creationId: activeRequest.creationId,
          machineId: activeRequest.repository.machineId,
        }))
      } catch (error) {
        if (error instanceof Error && /unknown worktree creation/i.test(error.message)) {
          return acceptSnapshot(await options.worktrees.create(activeRequest))
        }
        throw error
      }
    },

    async startInProject() {
      if (!activeIntent || activeIntent.checkout !== 'worktree') {
        throw new Error('No failed worktree creation is available for explicit fallback.')
      }
      if (!current.snapshot?.recoveryActions.includes('start_in_project')) {
        throw new Error('Resolve or retain the existing worktree before starting in the project checkout.')
      }
      const creationId = options.createId()
      const conversationId = options.createId()
      const result = await options.parent.create({
        creationId,
        conversationId,
        projectPath: activeIntent.projectPath,
        machineId: activeIntent.machineId,
        agentType: activeIntent.agentType,
        runtimeMode: activeIntent.runtimeMode,
        title: 'New conversation',
      })
      if (activeRequest) options.journal?.remove(activeRequest.creationId)
      return result
    },

    state: () => current,
    dismiss() {
      if (activeRequest) options.journal?.remove(activeRequest.creationId)
    },
    dispose: unsubscribe,
  }
}
