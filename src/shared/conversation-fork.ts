import type { ReasoningEffort } from './models'
import type { RuntimeMode } from './provider-events'
import type { AgentType, ChatMessage, MessageRole } from './types'

export const FORK_CONVERSATION_SCHEMA_VERSION = 1 as const

export interface ForkAnchor {
  messageId: string
  role: MessageRole
  timestamp: number
  contentDigest: string
}

export interface DirtySourceConfirmation {
  headSha: string
  statusDigest: string
}

export type ForkCheckout =
  | { kind: 'shared-checkout' }
  | {
      kind: 'new-worktree'
      basePolicy: 'source-head'
      dirtySourceConfirmed?: DirtySourceConfirmation
    }

export type ForkConversationSurface = 'desktop' | 'react-native' | 'android' | 'automation'

export interface ForkConversationRequest {
  schemaVersion: typeof FORK_CONVERSATION_SCHEMA_VERSION
  requestId: string
  sourceConversationId: string
  machineId?: string
  anchor: ForkAnchor
  checkout: ForkCheckout
  provenance: {
    surface: ForkConversationSurface
    requestedAt: number
  }
}

export interface ResolvedForkAnchor extends ForkAnchor {
  canonicalIndex: number
  canonicalMessageCount: number
  resolution: 'exact-id' | 'unique-legacy-fingerprint'
  provider?: 'claude-code' | 'codex' | 'opencode' | null
  providerSessionId?: string | null
  providerEventId?: string | null
}

export type ForkResumeMode = 'native' | 'transcript-handoff'

export interface ForkConversationState {
  id: string
  projectPath: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeId: string | null
  machineId?: string
  agentType: AgentType
  providerInstanceId: string | null
  runtimeMode: RuntimeMode
  model: string | null
  reasoningEffort: ReasoningEffort | null
  launchConfigName: string | null
  title: string
  parentConversationId: string
  anchor: ResolvedForkAnchor
  resumeMode: ForkResumeMode
  createdAt: number
}

export interface ForkWarning {
  code: string
  message: string
}

export interface ForkConversationResult {
  requestId: string
  conversation: ForkConversationState
  messages: ChatMessage[]
  nativeResume?: {
    provider: 'claude'
    sessionId: string
  }
  git?: {
    baseSha: string
    path: string
    branch: string
    sourceDirty: boolean
    omittedChangeSummary?: string
  }
  warnings: ForkWarning[]
}

export interface DirtySourceReceipt {
  headSha: string
  statusDigest: string
  trackedChanges: number
  untrackedChanges: number
  omittedChangeSummary: string
}

export type ForkErrorCode =
  | 'invalid-request'
  | 'idempotency-conflict'
  | 'source-not-found'
  | 'anchor-conflict'
  | 'dirty-source-changed'
  | 'git-failed'
  | 'provider-artifact-failed'
  | 'persistence-failed'
  | 'cleanup-required'
  | 'machine-disconnected'
  | 'completion-unknown'
  | 'upgrade-required'

export interface ForkError {
  code: ForkErrorCode
  message: string
  retryable: boolean
}

export interface ForkRecoveryReceipt {
  retainedPath?: string
  retainedBranch?: string
  cleanupSafe: boolean
}

export type ForkConversationOutcome =
  | {
      kind: 'confirmation-required'
      requestId: string
      dirtySource: DirtySourceReceipt
    }
  | {
      kind: 'completed'
      result: ForkConversationResult
    }
  | {
      kind: 'failed'
      requestId: string
      error: ForkError
      recovery?: ForkRecoveryReceipt
    }

export interface ForkConversationValidationIssue {
  code: 'required' | 'invalid_type' | 'invalid_value'
  path: string
  message: string
}

export type ForkConversationParseResult =
  | { ok: true; value: ForkConversationRequest }
  | { ok: false; issues: ForkConversationValidationIssue[] }

type UnknownRecord = Record<string, unknown>

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SHA256 = /^[0-9a-f]{64}$/i
const COMMIT_SHA = /^[0-9a-f]{40,64}$/i
const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system'])
const SURFACES: ReadonlySet<string> = new Set(['desktop', 'react-native', 'android', 'automation'])

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
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

export function canonicalizeForkConversationRequest(request: ForkConversationRequest): string {
  return JSON.stringify(stableValue(request))
}

export function canonicalizeForkConversationIdentity(request: ForkConversationRequest): string {
  const { requestedAt: _requestedAt, ...provenance } = request.provenance
  return JSON.stringify(stableValue({ ...request, provenance }))
}

export function canonicalizeForkMessage(message: ChatMessage): string {
  const { id: _id, ...durable } = message
  return JSON.stringify(stableValue(durable))
}

export function digestForkMessage(
  message: ChatMessage,
  sha256: (canonicalMessage: string) => string,
): string {
  const digest = sha256(canonicalizeForkMessage(message)).toLowerCase()
  if (!SHA256.test(digest)) throw new Error('Fork message digest must be a SHA-256 hex value')
  return digest
}

export function parseForkConversationRequest(input: unknown): ForkConversationParseResult {
  const issues: ForkConversationValidationIssue[] = []
  const issue = (
    code: ForkConversationValidationIssue['code'],
    path: string,
    message: string,
  ): void => {
    issues.push({ code, path, message })
  }
  const root = record(input)
  if (!root) {
    return {
      ok: false,
      issues: [{ code: 'invalid_type', path: '', message: 'Fork request must be an object.' }],
    }
  }

  if (root.schemaVersion !== FORK_CONVERSATION_SCHEMA_VERSION) {
    issue('invalid_value', 'schemaVersion', `schemaVersion must be ${FORK_CONVERSATION_SCHEMA_VERSION}.`)
  }
  if (typeof root.requestId !== 'string' || !IDENTIFIER.test(root.requestId)) {
    issue('invalid_value', 'requestId', 'requestId must be a stable identifier without whitespace.')
  }
  if (typeof root.sourceConversationId !== 'string' || !IDENTIFIER.test(root.sourceConversationId)) {
    issue('invalid_value', 'sourceConversationId', 'sourceConversationId must be a stable identifier.')
  }
  if (root.machineId !== undefined && (typeof root.machineId !== 'string' || !IDENTIFIER.test(root.machineId))) {
    issue('invalid_value', 'machineId', 'machineId must be a stable identifier when provided.')
  }

  const anchor = record(root.anchor)
  if (!anchor) {
    issue('required', 'anchor', 'anchor is required.')
  } else {
    if (typeof anchor.messageId !== 'string' || !IDENTIFIER.test(anchor.messageId)) {
      issue('invalid_value', 'anchor.messageId', 'anchor.messageId must be a stable identifier.')
    }
    if (typeof anchor.role !== 'string' || !ROLES.has(anchor.role)) {
      issue('invalid_value', 'anchor.role', 'anchor.role must be a durable message role.')
    }
    if (!Number.isSafeInteger(anchor.timestamp) || (anchor.timestamp as number) < 0) {
      issue('invalid_value', 'anchor.timestamp', 'anchor.timestamp must be a non-negative integer.')
    }
    if (typeof anchor.contentDigest !== 'string' || !SHA256.test(anchor.contentDigest)) {
      issue('invalid_value', 'anchor.contentDigest', 'anchor.contentDigest must be a SHA-256 hex value.')
    }
  }

  const checkout = record(root.checkout)
  if (!checkout) {
    issue('required', 'checkout', 'checkout is required.')
  } else if (checkout.kind === 'shared-checkout') {
    // No additional behavior-bearing fields.
  } else if (checkout.kind === 'new-worktree') {
    if (checkout.basePolicy !== 'source-head') {
      issue('invalid_value', 'checkout.basePolicy', 'new worktrees must use the source HEAD.')
    }
    if (checkout.dirtySourceConfirmed !== undefined) {
      const confirmation = record(checkout.dirtySourceConfirmed)
      if (!confirmation) {
        issue('invalid_type', 'checkout.dirtySourceConfirmed', 'dirty source confirmation must be an object.')
      } else {
        if (typeof confirmation.headSha !== 'string' || !COMMIT_SHA.test(confirmation.headSha)) {
          issue('invalid_value', 'checkout.dirtySourceConfirmed.headSha', 'headSha must be an exact commit SHA.')
        }
        if (typeof confirmation.statusDigest !== 'string' || !SHA256.test(confirmation.statusDigest)) {
          issue('invalid_value', 'checkout.dirtySourceConfirmed.statusDigest', 'statusDigest must be a SHA-256 hex value.')
        }
      }
    }
  } else {
    issue('invalid_value', 'checkout.kind', 'checkout.kind is not supported.')
  }

  const provenance = record(root.provenance)
  if (!provenance) {
    issue('required', 'provenance', 'provenance is required.')
  } else {
    if (typeof provenance.surface !== 'string' || !SURFACES.has(provenance.surface)) {
      issue('invalid_value', 'provenance.surface', 'provenance.surface is not supported.')
    }
    if (!Number.isSafeInteger(provenance.requestedAt) || (provenance.requestedAt as number) < 0) {
      issue('invalid_value', 'provenance.requestedAt', 'provenance.requestedAt must be a non-negative integer.')
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  const parsedAnchor = anchor as UnknownRecord
  const parsedCheckout = checkout as UnknownRecord
  const parsedProvenance = provenance as UnknownRecord
  const value: ForkConversationRequest = {
    schemaVersion: FORK_CONVERSATION_SCHEMA_VERSION,
    requestId: root.requestId as string,
    sourceConversationId: root.sourceConversationId as string,
    ...(root.machineId === undefined ? {} : { machineId: root.machineId as string }),
    anchor: {
      messageId: parsedAnchor.messageId as string,
      role: parsedAnchor.role as MessageRole,
      timestamp: parsedAnchor.timestamp as number,
      contentDigest: (parsedAnchor.contentDigest as string).toLowerCase(),
    },
    checkout: parsedCheckout.kind === 'shared-checkout'
      ? { kind: 'shared-checkout' }
      : {
          kind: 'new-worktree',
          basePolicy: 'source-head',
          ...(parsedCheckout.dirtySourceConfirmed === undefined
            ? {}
            : {
                dirtySourceConfirmed: {
                  headSha: ((parsedCheckout.dirtySourceConfirmed as UnknownRecord).headSha as string).toLowerCase(),
                  statusDigest: ((parsedCheckout.dirtySourceConfirmed as UnknownRecord).statusDigest as string).toLowerCase(),
                },
              }),
        },
    provenance: {
      surface: parsedProvenance.surface as ForkConversationSurface,
      requestedAt: parsedProvenance.requestedAt as number,
    },
  }
  return { ok: true, value }
}
