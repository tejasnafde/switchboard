import type { ProviderKind, RuntimeMode } from '@shared/provider-events'
import type { AgentType } from '@shared/types'
import type {
  WorktreeCreationActionRequest,
  WorktreeCreationProgressEvent,
  WorktreeCreationRecoveryAction,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
  WorktreeExistingBranchIntent,
  WorktreeSetupPolicy,
} from '@shared/worktree-creation'
import type { MobileNewSessionCreationStorage, PersistedMobileNewSessionCreation } from './new-session-creation-storage'

export interface NewSessionProviderIntent {
  kind?: ProviderKind
  instanceId?: string
  model?: string
  runtimeMode?: RuntimeMode
}

export interface MobileNewSessionIntent {
  connectionId: string
  machineId: string
  projectPath: string
  projectName: string
  checkout:
    | { kind: 'parent-checkout' }
    | {
        kind: 'worktree'
        baseRef: string
        branchSeed: string
        setupPolicy: WorktreeSetupPolicy
        /** Check out this branch (a PR head) instead of a fresh one; needs `worktree_existing_branch_v1`. */
        existingBranch?: WorktreeExistingBranchIntent
      }
  conversation: {
    id: string
    agentType: AgentType
  }
  provider: NewSessionProviderIntent
  firstMessage?: string
}

export interface ParentCheckoutRequest {
  creationId: string
  machineId: string
  projectPath: string
  projectName: string
  conversation: MobileNewSessionIntent['conversation']
  provider: NewSessionProviderIntent
  firstMessage?: string
}

export interface ParentCheckoutResult {
  creationId: string
  threadId: string
  projectPath: string
  title: string
}

export interface MobileNewSessionReadyResult {
  connectionId: string
  threadId: string
  title: string
  projectPath: string
  worktreePath?: string
  branch?: string
  worktreeId?: string
  creationId: string
}

export type MobileNewSessionCreationStatus =
  | 'idle'
  | 'submitting'
  | 'pending'
  | 'ambiguous'
  | 'failed'
  | 'rolled_back'
  | 'cleanup_required'
  | 'cancelled'
  | 'ready'

export interface MobileNewSessionCreationState {
  creationId?: string
  status: MobileNewSessionCreationStatus
  intent?: MobileNewSessionIntent
  snapshot?: WorktreeCreationSnapshot
  progress?: WorktreeCreationProgressEvent
  error?: string
}

export interface MobileNewSessionCreationCoordinatorOptions {
  nextCreationId(): string
  now(): number
  worktrees: {
    create(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
    get(request: { creationId: string; machineId: string }): Promise<WorktreeCreationSnapshot>
    act?(request: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot>
    subscribe?(handler: (event: WorktreeCreationProgressEvent) => void): () => void
  }
  storage?: MobileNewSessionCreationStorage
  parentCheckout: {
    create(request: ParentCheckoutRequest): Promise<ParentCheckoutResult>
  }
  onReady(result: MobileNewSessionReadyResult): void
}

export interface MobileNewSessionCreationActions {
  canRetry: boolean
  canStartInProject: boolean
  canChooseSetupRun: boolean
  canChooseSetupSkip: boolean
  canCheckStatus: boolean
  canCancel: boolean
  canRetain: boolean
  canRemove: boolean
  progressLabel: string
  correlation?: string
}

/** Recovery actions the coordinator sends through `worktree-creation:act` as-is. */
export type WorktreeActAction = Extract<
  WorktreeCreationRecoveryAction,
  'choose_setup_run' | 'choose_setup_skip' | 'cancel' | 'retain' | 'remove'
>

export function newSessionCreationActions(state: MobileNewSessionCreationState): MobileNewSessionCreationActions {
  const recovery = state.snapshot?.recoveryActions ?? state.progress?.recoveryActions ?? []
  const canRetry = state.status === 'ambiguous' || recovery.includes('retry')
  const canStartInProject =
    state.intent?.checkout.kind === 'worktree' &&
    (recovery.includes('start_in_project') || (!state.snapshot && state.status === 'failed'))
  const snapshot = state.snapshot
  return {
    canRetry,
    canStartInProject,
    canChooseSetupRun: recovery.includes('choose_setup_run'),
    canChooseSetupSkip: recovery.includes('choose_setup_skip'),
    // A definite rejection (failed with no snapshot) never reached the backend, so there is nothing to check.
    canCheckStatus:
      state.intent?.checkout.kind === 'worktree' &&
      state.status !== 'submitting' &&
      !(state.status === 'failed' && !snapshot),
    canCancel: recovery.includes('cancel'),
    canRetain: recovery.includes('retain'),
    canRemove: recovery.includes('remove'),
    progressLabel: progressLabel(state),
    ...(snapshot ? { correlation: `Creation ${snapshot.creationId}, revision ${snapshot.revision}` } : {}),
  }
}

function progressLabel(state: MobileNewSessionCreationState): string {
  switch (state.status) {
    case 'failed':
      return 'Worktree creation failed'
    case 'rolled_back':
      return 'Worktree creation rolled back'
    case 'cancelled':
      return 'Worktree creation cancelled'
    case 'cleanup_required':
      switch (state.snapshot?.cleanupDisposition) {
        case 'retained':
          return 'Worktree retained for recovery'
        case 'removed':
          return 'Worktree removed'
        case 'removal_refused':
          return 'Worktree removal was refused'
        default:
          return 'Worktree cleanup required'
      }
    case 'ambiguous':
      return 'Checking whether the worktree was created'
    default:
      return state.progress?.detail ?? phaseLabel(state.progress?.phase ?? state.snapshot?.phase)
  }
}

function phaseLabel(phase: WorktreeCreationSnapshot['phase'] | undefined): string {
  switch (phase) {
    case 'materializing':
      return 'Creating worktree'
    case 'configuring':
      return 'Configuring worktree'
    case 'linking':
      return 'Linking conversation'
    case 'awaiting_setup_decision':
      return 'Waiting for setup choice'
    case 'provisioning':
      return 'Starting session'
    case 'ready':
      return 'Session ready'
    default:
      return 'Preparing worktree'
  }
}

function isMissingWorktreeHandler(error: unknown): boolean {
  return error instanceof Error && /^no handler: worktree-creation:(create|get|act)$/i.test(error.message)
}

function isMissingWorktreeCreation(error: unknown): boolean {
  return error instanceof Error && /^Unknown worktree creation .+\.$/i.test(error.message)
}

const DEFINITE_WORKTREE_ERROR_NAMES = new Set([
  'WorktreeCreationConflictError',
  'WorktreeCreationOwnerConflictError',
  'WorktreeCreationRevisionConflictError',
  'WorktreeCreationUnsafeActionError',
  'WorktreeCreationValidationError',
])

const DEFINITE_WORKTREE_MESSAGE_PATTERNS = [
  /not authenticated/i,
  /not permitted:/i,
  /requires? (?:the )?.*scope/i,
  /choose skip setup/i,
  /already (?:bound|linked|has a conversation)/i,
  // Existing-branch refusals at plan time: nothing was reserved.
  /is already checked out in /i,
  /^Branch .+ does not exist in /i,
  /has no remote (?:named|for) /i,
  /owner .* precondition/i,
  /\b(?:invalid|unsafe|unsupported)\b/i,
  /\bis required\b/i,
  /\brequires? (?:a|an|the)\b/i,
  /\bmust (?:be|match)\b/i,
  /\bis supported\b/i,
  /not (?:implemented|supported)/i,
]

function isDefiniteWorktreeRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (DEFINITE_WORKTREE_ERROR_NAMES.has(error.name) || isMissingWorktreeHandler(error)) return true
  return DEFINITE_WORKTREE_MESSAGE_PATTERNS.some((pattern) => pattern.test(error.message))
}

export function createNewSessionCreationCoordinator(options: MobileNewSessionCreationCoordinatorOptions) {
  let state: MobileNewSessionCreationState = { status: 'idle' }
  let worktreeRequest: WorktreeCreationRequest | null = null
  let submissionPhase: PersistedMobileNewSessionCreation['submissionPhase'] | null = null
  let createDisposition: 'unknown' | 'ambiguous' | 'definite_rejection' = 'unknown'
  let disposed = false
  const listeners = new Set<(state: MobileNewSessionCreationState) => void>()

  const publish = (next: MobileNewSessionCreationState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }

  const persistedRecord = (): PersistedMobileNewSessionCreation | null => {
    if (!worktreeRequest || !state.intent || !submissionPhase) return null
    return {
      version: 1,
      submissionPhase,
      intent: state.intent,
      request: worktreeRequest,
      ...(state.snapshot ? { snapshot: state.snapshot } : {}),
    }
  }

  const persist = async (): Promise<void> => {
    const record = persistedRecord()
    if (record && options.storage) await options.storage.save(record)
  }

  const removePersisted = async (intent: MobileNewSessionIntent): Promise<void> => {
    await options.storage?.remove(intent.connectionId, intent.projectPath)
  }

  const acceptSnapshot = async (snapshot: WorktreeCreationSnapshot): Promise<void> => {
    // A read that started before an action can answer after it.
    if (state.snapshot?.creationId === snapshot.creationId && snapshot.revision < state.snapshot.revision) return
    createDisposition = 'unknown'
    const intent = state.intent
    const nextState: MobileNewSessionCreationState = {
      ...state,
      creationId: snapshot.creationId,
      status: snapshot.status === 'ready' ? 'ready' : snapshot.status,
      snapshot,
      error: snapshot.error?.message,
    }
    if (disposed) {
      state = nextState
      await persist()
      return
    }
    publish(nextState)
    if (snapshot.status === 'ready' && snapshot.worktreeId && snapshot.worktreePath && snapshot.branch && intent) {
      options.onReady({
        connectionId: intent.connectionId,
        threadId: snapshot.startupReceipt?.providerThreadId ?? intent.conversation.id,
        title: intent.projectName,
        projectPath: snapshot.projectPath,
        worktreePath: snapshot.worktreePath,
        branch: snapshot.branch,
        worktreeId: snapshot.worktreeId,
        creationId: snapshot.creationId,
      })
      await removePersisted(intent)
    } else if (
      intent &&
      snapshot.status !== 'pending' &&
      snapshot.status !== 'ready' &&
      snapshot.recoveryActions.length === 0
    ) {
      // Cancelled, removed or rolled back with nothing left to act on: do not restore it next time.
      await removePersisted(intent)
    } else {
      await persist()
    }
  }

  const classifyFailure = async (error: unknown): Promise<'ambiguous' | 'definite_rejection'> => {
    const missingHandler = isMissingWorktreeHandler(error)
    const disposition = isDefiniteWorktreeRejection(error) ? 'definite_rejection' : 'ambiguous'
    publish({
      ...state,
      status: disposition === 'definite_rejection' ? 'failed' : 'ambiguous',
      error: missingHandler
        ? 'This backend does not support worktree creation yet. Update it or start explicitly in the project.'
        : error instanceof Error
          ? error.message
          : String(error),
    })
    await persist().catch(() => undefined)
    return disposition
  }

  const submitWorktree = async (): Promise<void> => {
    if (!worktreeRequest) throw new Error('No worktree creation is available to submit.')
    publish({ ...state, status: 'submitting', error: undefined })
    if (submissionPhase === 'prepared') {
      submissionPhase = 'submitted'
      try {
        await persist()
      } catch (error) {
        submissionPhase = 'prepared'
        publish({
          ...state,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
    try {
      await acceptSnapshot(await options.worktrees.create(worktreeRequest))
    } catch (error) {
      createDisposition = await classifyFailure(error)
    }
  }

  const submitParentCheckout = async (intent: MobileNewSessionIntent, creationId: string): Promise<void> => {
    publish({ creationId, intent, status: 'submitting' })
    try {
      const result = await options.parentCheckout.create({
        creationId,
        machineId: intent.machineId,
        projectPath: intent.projectPath,
        projectName: intent.projectName,
        conversation: intent.conversation,
        provider: intent.provider,
        ...(intent.firstMessage ? { firstMessage: intent.firstMessage } : {}),
      })
      publish({ creationId: result.creationId, intent, status: 'ready' })
      if (!disposed) {
        options.onReady({
          connectionId: intent.connectionId,
          threadId: result.threadId,
          title: result.title,
          projectPath: result.projectPath,
          creationId: result.creationId,
        })
      }
      await removePersisted(intent)
    } catch (error) {
      publish({
        creationId,
        intent,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const reconcile = async (): Promise<void> => {
    if (!worktreeRequest || !state.creationId || !state.intent) {
      throw new Error('No worktree creation is available to reconcile.')
    }
    if (createDisposition === 'definite_rejection' && !state.snapshot) return
    try {
      await acceptSnapshot(
        await options.worktrees.get({
          creationId: state.creationId,
          machineId: state.intent.machineId,
        }),
      )
    } catch (error) {
      if (isMissingWorktreeCreation(error)) {
        // The backend lost the record, so a resubmitted create restarts its revisions.
        state = { ...state, snapshot: undefined }
        await submitWorktree()
        return
      }
      createDisposition = await classifyFailure(error)
    }
  }

  const sendAction = async (
    intent: MobileNewSessionIntent,
    snapshot: WorktreeCreationSnapshot,
    action: WorktreeCreationRecoveryAction,
  ): Promise<void> => {
    const act = options.worktrees.act
    if (!act) throw new Error('This worktree action is not available.')
    publish({ ...state, status: 'submitting', error: undefined })
    try {
      await acceptSnapshot(
        await act({
          creationId: snapshot.creationId,
          machineId: intent.machineId,
          expectedRevision: snapshot.revision,
          action,
        }),
      )
    } catch (error) {
      // A refused action leaves the creation as it was: keep its status so the title still describes it.
      if ((await classifyFailure(error)) === 'definite_rejection') publish({ ...state, status: snapshot.status })
    }
  }

  const unsubscribeProgress = options.worktrees.subscribe?.((event) => {
    if (disposed || event.creationId !== state.creationId) return
    publish({ ...state, status: event.status, progress: event })
    void reconcile()
  })

  return {
    async begin(intent: MobileNewSessionIntent): Promise<void> {
      createDisposition = 'unknown'
      const creationId = options.nextCreationId()
      if (intent.checkout.kind === 'parent-checkout') {
        worktreeRequest = null
        submissionPhase = null
        await submitParentCheckout(intent, creationId)
        return
      }
      worktreeRequest = {
        schemaVersion: 1,
        creationId,
        repository: {
          projectPath: intent.projectPath,
          machineId: intent.machineId,
        },
        checkout: {
          baseRef: intent.checkout.baseRef,
          branch: { namespace: 'sb', seed: intent.checkout.branchSeed },
          location: 'managed-in-repo',
          ...(intent.checkout.existingBranch ? { existingBranch: intent.checkout.existingBranch } : {}),
        },
        owner: {
          kind: 'conversation',
          conversationId: intent.conversation.id,
          agentType: intent.conversation.agentType,
        },
        purpose: 'new-chat',
        setup: { policy: intent.checkout.setupPolicy },
        launch: {
          initialAgent: {
            provider: intent.conversation.agentType === 'terminal' ? 'claude-code' : intent.conversation.agentType,
            ...(intent.provider.instanceId ? { instanceId: intent.provider.instanceId } : {}),
            ...(intent.provider.model ? { model: intent.provider.model } : {}),
            ...(intent.provider.runtimeMode ? { runtimeMode: intent.provider.runtimeMode } : {}),
            ...(intent.firstMessage ? { prompt: intent.firstMessage } : {}),
          },
        },
        provenance: {
          surface: 'react-native',
          machineId: intent.machineId,
          requestedAt: options.now(),
        },
      }
      submissionPhase = 'prepared'
      publish({ creationId, intent, status: 'pending' })
      try {
        await persist()
      } catch (error) {
        publish({
          creationId,
          intent,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      await submitWorktree()
    },

    async restore(connectionId: string, projectPath: string): Promise<void> {
      if (!options.storage) return
      const record = await options.storage.load(connectionId, projectPath)
      if (!record) return
      createDisposition = 'unknown'
      worktreeRequest = record.request
      submissionPhase = record.submissionPhase ?? 'submitted'
      publish({
        creationId: record.request.creationId,
        intent: record.intent,
        status: record.snapshot?.status ?? 'pending',
        ...(record.snapshot ? { snapshot: record.snapshot } : {}),
      })
      if (submissionPhase === 'prepared') {
        await submitWorktree()
      } else {
        await reconcile()
      }
    },

    async retry(): Promise<void> {
      if (!worktreeRequest || !state.intent) {
        throw new Error('No worktree creation is available to retry.')
      }
      if (state.status === 'ambiguous') {
        await reconcile()
        return
      }
      const snapshot = state.snapshot
      if (snapshot?.recoveryActions.includes('retry') && options.worktrees.act) {
        await sendAction(state.intent, snapshot, 'retry')
        return
      }
      await persist()
      await submitWorktree()
    },

    reconcileAfterReconnect: reconcile,

    async act(action: WorktreeActAction): Promise<void> {
      const intent = state.intent
      const snapshot = state.snapshot
      if (!intent || !snapshot || !snapshot.recoveryActions.includes(action)) {
        throw new Error('This worktree action is not available.')
      }
      await sendAction(intent, snapshot, action)
    },

    async startInProject(): Promise<void> {
      const intent = state.intent
      if (!intent || intent.checkout.kind !== 'worktree') {
        throw new Error('No failed worktree creation is available for explicit fallback.')
      }
      if (!newSessionCreationActions(state).canStartInProject) {
        throw new Error('The failed worktree creation does not allow parent-checkout fallback.')
      }
      publish({ ...state, status: 'submitting', error: undefined })
      const parentIntent: MobileNewSessionIntent = {
        ...intent,
        checkout: { kind: 'parent-checkout' },
      }
      try {
        await removePersisted(intent)
      } catch (error) {
        publish({
          ...state,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      worktreeRequest = null
      submissionPhase = null
      await submitParentCheckout(parentIntent, options.nextCreationId())
    },

    subscribe(listener: (state: MobileNewSessionCreationState) => void): () => void {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      disposed = true
      unsubscribeProgress?.()
      listeners.clear()
    },

    getState(): MobileNewSessionCreationState {
      return state
    },
  }
}
