import type { RuntimeMode } from './provider-events'
import type { AgentType } from './types'

export const WORKTREE_CREATION_SCHEMA_VERSION = 1 as const

export type WorktreeCreationPhase =
  | 'pending'
  | 'materializing'
  | 'configuring'
  | 'linking'
  | 'awaiting_setup_decision'
  | 'provisioning'
  | 'ready'

export type WorktreeCreationStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'rolled_back'
  | 'cleanup_required'
  | 'cancelled'

export type WorktreePurpose = 'new-chat' | 'kanban' | 'fork'
export type WorktreeSetupPolicy = 'inherit' | 'run' | 'skip'
export type WorktreeCreationSurface = 'desktop' | 'react-native' | 'android' | 'automation' | 'legacy'

export interface WorktreeRepositoryIntent {
  projectPath: string
  machineId: string
}

export interface WorktreeSparseCheckoutIntent {
  mode: 'cone'
  directories: string[]
  presetId?: string
}

export interface WorktreeCheckoutIntent {
  baseRef: string
  branch: {
    namespace: 'sb' | 'fork' | 'kanban'
    seed: string
  }
  location?: 'managed-in-repo' | 'managed-user-data'
  sparseCheckout?: WorktreeSparseCheckoutIntent
}

export interface ConversationCreationOwner {
  kind: 'conversation'
  conversationId: string
  agentType: AgentType
  title?: string
}

export interface KanbanCardCreationDraft {
  title: string
  description?: string
  tags?: string[]
  status?: 'backlog' | 'in_progress' | 'needs_input' | 'done'
  runtimeMode?: RuntimeMode
  costCapUsd?: number | null
}

export interface KanbanCreationOwner {
  kind: 'kanban-card'
  cardId: string
  create?: KanbanCardCreationDraft
  expectedRevision?: number
}

export interface ForkCreationOwner {
  kind: 'fork'
  conversationId: string
  parentConversationId: string
  forkedAtMessageId?: string
  upToIndex: number
  title?: string
}

export type WorktreeCreationOwner =
  | ConversationCreationOwner
  | KanbanCreationOwner
  | ForkCreationOwner

export interface WorktreeSetupIntent {
  policy: WorktreeSetupPolicy
}

export interface WorktreeInitialAgentIntent {
  provider: Exclude<AgentType, 'terminal'>
  instanceId?: string
  model?: string
  runtimeMode?: RuntimeMode
  prompt?: string
}

export interface WorkspaceLaunchIntent {
  launchConfigName?: string
  startupCommand?: string
  initialAgent?: WorktreeInitialAgentIntent
  /** Backend-normalized authorization that survives retries and restart recovery. */
  terminalPolicy?: 'provision' | 'skip'
}

export interface WorktreeLineage {
  parentWorktreeId?: string
  parentConversationId?: string
  sourceMessageId?: string
}

export interface WorktreeCreationProvenance {
  surface: WorktreeCreationSurface
  machineId: string
  requestedAt: number
}

export interface WorktreeCreationRequest {
  schemaVersion: typeof WORKTREE_CREATION_SCHEMA_VERSION
  creationId: string
  repository: WorktreeRepositoryIntent
  checkout: WorktreeCheckoutIntent
  owner: WorktreeCreationOwner
  purpose: WorktreePurpose
  setup: WorktreeSetupIntent
  launch?: WorkspaceLaunchIntent
  lineage?: WorktreeLineage
  provenance: WorktreeCreationProvenance
}

export interface SparseCheckoutReceipt {
  mode: 'cone'
  directories: string[]
  presetId?: string
  status: 'not_requested' | 'configured' | 'failed'
}

export interface WorktreeSetupReceipt {
  requestedPolicy: WorktreeSetupPolicy
  resolvedPolicy: 'ask' | 'run' | 'skip'
  status: 'pending' | 'awaiting_decision' | 'not_configured' | 'skipped' | 'running' | 'succeeded' | 'failed' | 'ambiguous'
  commandSource?: 'launch-config' | 'request'
  commandFingerprint?: string
  startedAt?: number
  finishedAt?: number
  exitCode?: number
}

export interface WorktreeStartupReceipt {
  status: 'not_requested' | 'running' | 'succeeded' | 'failed' | 'ambiguous'
  terminalIds: string[]
  providerThreadId?: string
  initialPromptOrigin?: string
}

export interface WorktreeCreationError {
  code: string
  phase: WorktreeCreationPhase
  message: string
  retryable: boolean
}

export type WorktreeCreationRecoveryAction =
  | 'choose_setup_run'
  | 'choose_setup_skip'
  | 'retry'
  | 'cancel'
  | 'retain'
  | 'remove'
  | 'start_in_project'

export type WorktreeCleanupDisposition = 'retained' | 'removed' | 'removal_refused'

export interface WorktreeCreationSnapshot {
  creationId: string
  revision: number
  phase: WorktreeCreationPhase
  status: WorktreeCreationStatus
  worktreeId?: string
  projectPath: string
  worktreePath?: string
  branch?: string
  baseRef: string
  owner: WorktreeCreationOwner
  purpose: WorktreePurpose
  provenance: WorktreeCreationProvenance
  lineage?: WorktreeLineage
  sparseCheckoutReceipt?: SparseCheckoutReceipt
  setupReceipt?: WorktreeSetupReceipt
  startupReceipt?: WorktreeStartupReceipt
  warnings: string[]
  error?: WorktreeCreationError
  cleanupDisposition?: WorktreeCleanupDisposition
  recoveryActions: WorktreeCreationRecoveryAction[]
  updatedAt: number
}

export interface GetWorktreeCreationRequest {
  creationId: string
  machineId: string
}

export interface WorktreeCreationActionRequest {
  creationId: string
  machineId: string
  expectedRevision: number
  action: WorktreeCreationRecoveryAction
}

export interface WorktreeCreationProgressEvent {
  creationId: string
  revision: number
  phase: WorktreeCreationPhase
  status: WorktreeCreationStatus
  timestamp: number
  detail?: string
  recoveryActions: WorktreeCreationRecoveryAction[]
}

export interface WorktreeCreationValidationIssue {
  code:
    | 'required'
    | 'invalid_type'
    | 'invalid_value'
    | 'invalid_git_ref'
    | 'invalid_sparse_path'
    | 'owner_purpose_mismatch'
    | 'machine_mismatch'
  path: string
  message: string
}

export type WorktreeCreationParseResult =
  | { ok: true; value: WorktreeCreationRequest }
  | { ok: false; issues: WorktreeCreationValidationIssue[] }

type UnknownRecord = Record<string, unknown>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const AGENT_TYPE_VALUES: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode', 'terminal'])
const PROVIDERS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode'])
const RUNTIME_MODES: ReadonlySet<string> = new Set(['plan', 'sandbox', 'accept-edits', 'full-access'])

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}

function validGitRef(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('-') &&
    !/\s/.test(value) &&
    !hasControlCharacters(value)
}

function validBranchSeed(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 120 &&
    !value.trim().startsWith('-') &&
    !value.includes('..') &&
    !hasControlCharacters(value)
}

function normalizeSparsePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return null
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return null
  const parts = value.split('/')
  if (parts.some((part) => part === '..')) return null
  const normalized = parts.filter((part) => part.length > 0).join('/')
  if (!normalized || normalized === '.') return null
  return normalized
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  const object = record(value)
  if (!object) return value
  const output: UnknownRecord = {}
  for (const key of Object.keys(object).sort()) {
    if (object[key] !== undefined) output[key] = stableValue(object[key])
  }
  return output
}

export function canonicalizeWorktreeCreationRequest(request: WorktreeCreationRequest): string {
  return JSON.stringify(stableValue(request))
}

export function canonicalizeWorktreeCreationIdentity(request: WorktreeCreationRequest): string {
  const { requestedAt: _requestedAt, ...provenance } = request.provenance
  const launch = request.launch
    ? (() => {
        const { terminalPolicy: _terminalPolicy, ...intent } = request.launch
        return intent
      })()
    : undefined
  return JSON.stringify(stableValue({
    ...request,
    ...(launch ? { launch } : {}),
    provenance,
  }))
}

export function parseWorktreeCreationRequest(input: unknown): WorktreeCreationParseResult {
  const issues: WorktreeCreationValidationIssue[] = []
  const issue = (code: WorktreeCreationValidationIssue['code'], path: string, message: string): void => {
    issues.push({ code, path, message })
  }
  const root = record(input)
  if (!root) return { ok: false, issues: [{ code: 'invalid_type', path: '', message: 'Request must be an object.' }] }

  if (root.schemaVersion !== WORKTREE_CREATION_SCHEMA_VERSION) {
    issue('invalid_value', 'schemaVersion', 'Unsupported worktree creation schema version.')
  }
  if (!validIdentifier(root.creationId)) {
    issue('invalid_value', 'creationId', 'creationId must be a stable identifier without whitespace.')
  }

  const repository = record(root.repository)
  if (!repository) issue('required', 'repository', 'Repository intent is required.')
  const projectPath = repository?.projectPath
  const repositoryMachineId = repository?.machineId
  if (!validAbsolutePath(projectPath)) issue('invalid_value', 'repository.projectPath', 'Project path must be absolute.')
  if (!validIdentifier(repositoryMachineId)) issue('invalid_value', 'repository.machineId', 'Machine identity is invalid.')

  const checkout = record(root.checkout)
  if (!checkout) issue('required', 'checkout', 'Checkout intent is required.')
  const baseRef = checkout?.baseRef
  if (!validGitRef(baseRef)) issue('invalid_git_ref', 'checkout.baseRef', 'Base ref is empty or unsafe.')
  const branch = record(checkout?.branch)
  const namespace = branch?.namespace
  if (namespace !== 'sb' && namespace !== 'fork' && namespace !== 'kanban') {
    issue('invalid_value', 'checkout.branch.namespace', 'Branch namespace is invalid.')
  }
  const seed = branch?.seed
  if (!validBranchSeed(seed)) issue('invalid_value', 'checkout.branch.seed', 'Branch seed is empty or unsafe.')
  const location = checkout?.location
  if (location !== undefined && location !== 'managed-in-repo' && location !== 'managed-user-data') {
    issue('invalid_value', 'checkout.location', 'Managed location is invalid.')
  }

  let sparseCheckout: WorktreeSparseCheckoutIntent | undefined
  if (checkout?.sparseCheckout !== undefined) {
    const sparse = record(checkout.sparseCheckout)
    if (!sparse) {
      issue('invalid_type', 'checkout.sparseCheckout', 'Sparse checkout must be an object.')
    } else {
      if (sparse.mode !== 'cone') issue('invalid_value', 'checkout.sparseCheckout.mode', 'Only cone sparse checkout is supported.')
      if (!Array.isArray(sparse.directories) || sparse.directories.length === 0) {
        issue('required', 'checkout.sparseCheckout.directories', 'At least one sparse directory is required.')
      } else {
        const normalized: string[] = []
        sparse.directories.forEach((directory, index) => {
          const path = normalizeSparsePath(directory)
          if (path === null) {
            issue('invalid_sparse_path', `checkout.sparseCheckout.directories[${index}]`, 'Sparse paths must be repository-relative cone directories.')
          } else {
            normalized.push(path)
          }
        })
        if (sparse.mode === 'cone') {
          sparseCheckout = {
            mode: 'cone',
            directories: [...new Set(normalized)].sort(),
            ...(optionalString(sparse.presetId) ? { presetId: sparse.presetId as string } : {}),
          }
        }
      }
    }
  }

  const ownerInput = record(root.owner)
  if (!ownerInput) issue('required', 'owner', 'Owner intent is required.')
  let owner: WorktreeCreationOwner | undefined
  if (ownerInput?.kind === 'conversation') {
    if (!validIdentifier(ownerInput.conversationId)) issue('invalid_value', 'owner.conversationId', 'Conversation identity is invalid.')
    if (!AGENT_TYPE_VALUES.has(ownerInput.agentType as string)) issue('required', 'owner.agentType', 'Conversation agent type is required.')
    if (validIdentifier(ownerInput.conversationId) && AGENT_TYPE_VALUES.has(ownerInput.agentType as string)) {
      owner = {
        kind: 'conversation',
        conversationId: ownerInput.conversationId,
        agentType: ownerInput.agentType as AgentType,
        ...(optionalString(ownerInput.title) ? { title: ownerInput.title as string } : {}),
      }
    }
  } else if (ownerInput?.kind === 'kanban-card') {
    if (!validIdentifier(ownerInput.cardId)) issue('invalid_value', 'owner.cardId', 'Card identity is invalid.')
    let create: KanbanCardCreationDraft | undefined
    if (ownerInput.create !== undefined) {
      const draft = record(ownerInput.create)
      if (!draft || !optionalString(draft.title)) {
        issue('required', 'owner.create.title', 'A new card requires a title.')
      } else {
        const tags = draft.tags === undefined
          ? undefined
          : Array.isArray(draft.tags) && draft.tags.every((tag) => typeof tag === 'string')
            ? draft.tags as string[]
            : null
        if (tags === null) issue('invalid_type', 'owner.create.tags', 'Card tags must be strings.')
        const status = draft.status
        if (status !== undefined && !['backlog', 'in_progress', 'needs_input', 'done'].includes(status as string)) {
          issue('invalid_value', 'owner.create.status', 'Card status is invalid.')
        }
        const runtimeMode = draft.runtimeMode
        if (runtimeMode !== undefined && !RUNTIME_MODES.has(runtimeMode as string)) {
          issue('invalid_value', 'owner.create.runtimeMode', 'Card runtime mode is invalid.')
        }
        const costCapUsd = draft.costCapUsd
        if (
          costCapUsd !== undefined
          && costCapUsd !== null
          && (typeof costCapUsd !== 'number' || !Number.isFinite(costCapUsd) || costCapUsd < 0)
        ) {
          issue('invalid_value', 'owner.create.costCapUsd', 'Card cost cap must be a non-negative number or null.')
        }
        create = {
          title: draft.title as string,
          ...(optionalString(draft.description) ? { description: draft.description as string } : {}),
          ...(tags ? { tags } : {}),
          ...(status ? { status: status as KanbanCardCreationDraft['status'] } : {}),
          ...(runtimeMode ? { runtimeMode: runtimeMode as RuntimeMode } : {}),
          ...(costCapUsd === null || typeof costCapUsd === 'number' ? { costCapUsd } : {}),
        }
      }
    }
    const expectedRevision = ownerInput.expectedRevision
    if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0)) {
      issue('invalid_value', 'owner.expectedRevision', 'Expected revision must be a non-negative integer.')
    }
    if (validIdentifier(ownerInput.cardId)) {
      owner = {
        kind: 'kanban-card',
        cardId: ownerInput.cardId,
        ...(create ? { create } : {}),
        ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
      }
    }
  } else if (ownerInput?.kind === 'fork') {
    if (!validIdentifier(ownerInput.conversationId)) issue('invalid_value', 'owner.conversationId', 'Fork conversation identity is invalid.')
    if (!validIdentifier(ownerInput.parentConversationId)) issue('invalid_value', 'owner.parentConversationId', 'Parent conversation identity is invalid.')
    if (!Number.isInteger(ownerInput.upToIndex) || (ownerInput.upToIndex as number) < 0) {
      issue('invalid_value', 'owner.upToIndex', 'Fork boundary must be a non-negative integer.')
    }
    if (validIdentifier(ownerInput.conversationId) && validIdentifier(ownerInput.parentConversationId) && Number.isInteger(ownerInput.upToIndex)) {
      owner = {
        kind: 'fork',
        conversationId: ownerInput.conversationId,
        parentConversationId: ownerInput.parentConversationId,
        upToIndex: ownerInput.upToIndex as number,
        ...(optionalString(ownerInput.forkedAtMessageId) ? { forkedAtMessageId: ownerInput.forkedAtMessageId as string } : {}),
        ...(optionalString(ownerInput.title) ? { title: ownerInput.title as string } : {}),
      }
    }
  } else if (ownerInput) {
    issue('invalid_value', 'owner.kind', 'Owner kind is invalid.')
  }

  const purpose = root.purpose
  if (purpose !== 'new-chat' && purpose !== 'kanban' && purpose !== 'fork') {
    issue('invalid_value', 'purpose', 'Worktree purpose is invalid.')
  }
  const expectedOwnerKind = purpose === 'new-chat' ? 'conversation' : purpose === 'kanban' ? 'kanban-card' : purpose === 'fork' ? 'fork' : undefined
  if (ownerInput && expectedOwnerKind && ownerInput.kind !== expectedOwnerKind) {
    issue('owner_purpose_mismatch', 'owner.kind', `Purpose ${String(purpose)} requires a ${expectedOwnerKind} owner.`)
  }
  const expectedNamespace = purpose === 'new-chat' ? 'sb' : purpose === 'kanban' ? 'kanban' : purpose === 'fork' ? 'fork' : undefined
  if (expectedNamespace && namespace !== expectedNamespace) {
    issue('invalid_value', 'checkout.branch.namespace', `Purpose ${String(purpose)} requires the ${expectedNamespace} namespace.`)
  }

  const setupInput = record(root.setup)
  const setupPolicy = setupInput?.policy
  if (setupPolicy !== 'inherit' && setupPolicy !== 'run' && setupPolicy !== 'skip') {
    issue('invalid_value', 'setup.policy', 'Setup policy is invalid.')
  }

  let launch: WorkspaceLaunchIntent | undefined
  if (root.launch !== undefined) {
    const launchInput = record(root.launch)
    if (!launchInput) {
      issue('invalid_type', 'launch', 'Launch intent must be an object.')
    } else {
      let initialAgent: WorktreeInitialAgentIntent | undefined
      if (launchInput.initialAgent !== undefined) {
        const agent = record(launchInput.initialAgent)
        if (!agent || !PROVIDERS.has(agent.provider as string)) {
          issue('invalid_value', 'launch.initialAgent.provider', 'Initial provider is invalid.')
        } else {
          const runtimeMode = agent.runtimeMode
          if (runtimeMode !== undefined && !RUNTIME_MODES.has(runtimeMode as string)) {
            issue('invalid_value', 'launch.initialAgent.runtimeMode', 'Runtime mode is invalid.')
          }
          initialAgent = {
            provider: agent.provider as WorktreeInitialAgentIntent['provider'],
            ...(optionalString(agent.instanceId) ? { instanceId: agent.instanceId as string } : {}),
            ...(optionalString(agent.model) ? { model: agent.model as string } : {}),
            ...(runtimeMode && RUNTIME_MODES.has(runtimeMode as string) ? { runtimeMode: runtimeMode as RuntimeMode } : {}),
            ...(optionalString(agent.prompt) ? { prompt: agent.prompt as string } : {}),
          }
        }
      }
      launch = {
        ...(optionalString(launchInput.launchConfigName) ? { launchConfigName: launchInput.launchConfigName as string } : {}),
        ...(optionalString(launchInput.startupCommand) ? { startupCommand: launchInput.startupCommand as string } : {}),
        ...(initialAgent ? { initialAgent } : {}),
        ...(launchInput.terminalPolicy === 'provision' || launchInput.terminalPolicy === 'skip'
          ? { terminalPolicy: launchInput.terminalPolicy }
          : {}),
      }
      if (
        launchInput.terminalPolicy !== undefined
        && launchInput.terminalPolicy !== 'provision'
        && launchInput.terminalPolicy !== 'skip'
      ) {
        issue('invalid_value', 'launch.terminalPolicy', 'Terminal provisioning policy is invalid.')
      }
    }
  }

  let lineage: WorktreeLineage | undefined
  if (root.lineage !== undefined) {
    const lineageInput = record(root.lineage)
    if (!lineageInput) {
      issue('invalid_type', 'lineage', 'Lineage must be an object.')
    } else {
      lineage = {
        ...(optionalString(lineageInput.parentWorktreeId) ? { parentWorktreeId: lineageInput.parentWorktreeId as string } : {}),
        ...(optionalString(lineageInput.parentConversationId) ? { parentConversationId: lineageInput.parentConversationId as string } : {}),
        ...(optionalString(lineageInput.sourceMessageId) ? { sourceMessageId: lineageInput.sourceMessageId as string } : {}),
      }
    }
  }

  const provenanceInput = record(root.provenance)
  if (!provenanceInput) issue('required', 'provenance', 'Provenance is required.')
  const surface = provenanceInput?.surface
  if (!['desktop', 'react-native', 'android', 'automation', 'legacy'].includes(surface as string)) {
    issue('invalid_value', 'provenance.surface', 'Provenance surface is invalid.')
  }
  const provenanceMachineId = provenanceInput?.machineId
  if (!validIdentifier(provenanceMachineId)) issue('invalid_value', 'provenance.machineId', 'Provenance machine identity is invalid.')
  if (validIdentifier(repositoryMachineId) && validIdentifier(provenanceMachineId) && repositoryMachineId !== provenanceMachineId) {
    issue('machine_mismatch', 'provenance.machineId', 'Repository and provenance machines must match.')
  }
  const requestedAt = provenanceInput?.requestedAt
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt) || requestedAt <= 0) {
    issue('invalid_value', 'provenance.requestedAt', 'Request time is invalid.')
  }

  if (issues.length > 0 || !owner) return { ok: false, issues }

  return {
    ok: true,
    value: {
      schemaVersion: WORKTREE_CREATION_SCHEMA_VERSION,
      creationId: root.creationId as string,
      repository: {
        projectPath: projectPath as string,
        machineId: repositoryMachineId as string,
      },
      checkout: {
        baseRef: baseRef as string,
        branch: {
          namespace: namespace as WorktreeCheckoutIntent['branch']['namespace'],
          seed: (seed as string).trim(),
        },
        ...(location ? { location: location as WorktreeCheckoutIntent['location'] } : {}),
        ...(sparseCheckout ? { sparseCheckout } : {}),
      },
      owner,
      purpose: purpose as WorktreePurpose,
      setup: { policy: setupPolicy as WorktreeSetupPolicy },
      ...(launch ? { launch } : {}),
      ...(lineage ? { lineage } : {}),
      provenance: {
        surface: surface as WorktreeCreationSurface,
        machineId: provenanceMachineId as string,
        requestedAt: requestedAt as number,
      },
    },
  }
}
