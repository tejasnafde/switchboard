/**
 * The Instinct bridge contract: the owner's assistant (Instinct) finds,
 * starts, messages, reads and stops managed chats in the projects the owner
 * allows, through a relay. This file holds the wire version, the tool names,
 * the project policy, the public shapes, the states and the error codes. Main
 * and the relay share it; it has no runtime dependency.
 *
 * Staged flag `instinct_bridge`: off by default. SB_INSTINCT_BRIDGE=1 or the
 * backend setting `labs.instinct_bridge` turns it on.
 */
import type { SettingReader } from './limit-resume'
import { RUNTIME_MODES, type RuntimeMode } from './provider-events'
import type { AgentType } from './types'

export const INSTINCT_BRIDGE_ENABLED = false
export const INSTINCT_BRIDGE_LABS_SETTING = 'labs.instinct_bridge'
export const INSTINCT_BRIDGE_CAPABILITY = 'instinct_bridge_v1'
/** The relay and the desktop refuse a frame of another version with `unsupported_version`. */
export const BRIDGE_WIRE_VERSION = 1

export function instinctBridgeEnabled(env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  return (
    INSTINCT_BRIDGE_ENABLED || env.SB_INSTINCT_BRIDGE === '1' || getSetting(INSTINCT_BRIDGE_LABS_SETTING) === 'true'
  )
}

// ─── Tools ──────────────────────────────────────────────────────

/** The only tools the assistant key reaches. No shell, RPC, approval answer, enrollment or file tool. */
export const BRIDGE_TOOL_NAMES = [
  'search_chats',
  'list_projects',
  'list_recent_chats',
  'start_chat',
  'send_to_chat',
  'read_chat',
  'stop_chat',
] as const
export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number]

/** The tools that change something. Each takes an `idempotency_key` and returns a durable `call_id`. */
export const BRIDGE_OPERATIONS = ['start_chat', 'send_to_chat', 'stop_chat'] as const
export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number]

export function isBridgeOperation(value: unknown): value is BridgeOperation {
  return (BRIDGE_OPERATIONS as readonly unknown[]).includes(value)
}

/** Days a call record keeps its target. After that it is a tombstone and its key answers `request_retired`. */
export const BRIDGE_CALL_RETENTION_DAYS = 90
export const BRIDGE_CALL_RETENTION_MS = BRIDGE_CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000

// ─── Project policy ─────────────────────────────────────────────

export interface BridgeProjectActions {
  edit: boolean
  checks: boolean
  commit: boolean
  push: boolean
  pr: boolean
  merge: boolean
  deploy: boolean
}

/** Local edits and configured checks on. Commit, push and PR are setup choices; merge and deploy stay off. */
export const DEFAULT_BRIDGE_ACTIONS: Readonly<BridgeProjectActions> = Object.freeze({
  edit: true,
  checks: true,
  commit: false,
  push: false,
  pr: false,
  merge: false,
  deploy: false,
})

export const DEFAULT_BRIDGE_MODE: RuntimeMode = 'auto'

/** One allowed checkout on one machine. A matching project on another machine is a separate entry. */
export interface BridgeProjectPolicy {
  project_id: string
  label: string
  machine_id: string
  /** The realpath of the folder. Never in a public response. */
  canonical_local_root: string
  /** Empty means the normal saved agents. */
  allowed_agents: AgentType[]
  default_agent: AgentType | null
  default_model: string | null
  default_mode: RuntimeMode
  maximum_mode: RuntimeMode
  actions: BridgeProjectActions
}

export type BridgeProjectView = Omit<BridgeProjectPolicy, 'canonical_local_root'>

export function defaultBridgeProjectPolicy(input: {
  project_id: string
  label: string
  machine_id: string
  canonical_local_root: string
}): BridgeProjectPolicy {
  return {
    ...input,
    allowed_agents: [],
    default_agent: null,
    default_model: null,
    default_mode: DEFAULT_BRIDGE_MODE,
    maximum_mode: DEFAULT_BRIDGE_MODE,
    actions: { ...DEFAULT_BRIDGE_ACTIONS },
  }
}

export function publicProjectView(policy: BridgeProjectPolicy): BridgeProjectView {
  const { canonical_local_root: _root, ...view } = policy
  return view
}

function modeRank(mode: RuntimeMode): number {
  return RUNTIME_MODES.indexOf(mode)
}

/**
 * The mode a bridge request runs in: the policy default when none is asked,
 * the asked mode when it is at or below the cap. A wider or unknown mode is
 * refused, never lowered or promoted.
 */
export function resolveBridgeMode(
  requested: unknown,
  policy: Pick<BridgeProjectPolicy, 'default_mode' | 'maximum_mode'>,
): { ok: true; mode: RuntimeMode } | { ok: false; code: 'mode_not_allowed' } {
  const cap = modeRank(policy.maximum_mode)
  const mode = requested === undefined || requested === null ? policy.default_mode : requested
  const rank = RUNTIME_MODES.indexOf(mode as RuntimeMode)
  if (rank < 0 || cap < 0 || rank > cap) return { ok: false, code: 'mode_not_allowed' }
  return { ok: true, mode: mode as RuntimeMode }
}

/** A policy whose default mode is above its cap, or has an unknown mode, is not stored. */
export function bridgePolicyModesValid(policy: Pick<BridgeProjectPolicy, 'default_mode' | 'maximum_mode'>): boolean {
  const cap = modeRank(policy.maximum_mode)
  const def = modeRank(policy.default_mode)
  return cap >= 0 && def >= 0 && def <= cap
}

// ─── References and states ──────────────────────────────────────

/** `chat_id` is the root conversation id, stable across provider session rotation. */
export interface BridgeChatRef {
  machine_id: string
  chat_id: string
}

/** Accepted means the local service recorded the action, not that the agent replied or tests passed. */
export const BRIDGE_CALL_STATES = ['recorded', 'dispatching', 'accepted', 'rejected', 'delivery_unknown'] as const
export type BridgeCallState = (typeof BRIDGE_CALL_STATES)[number]

const CALL_TRANSITIONS: Record<BridgeCallState, readonly BridgeCallState[]> = {
  recorded: ['dispatching', 'rejected'],
  dispatching: ['accepted', 'rejected', 'delivery_unknown'],
  // Reconciled on the same machine from durable acceptance and provider state.
  delivery_unknown: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
}

export function bridgeCallTransitionAllowed(from: BridgeCallState, to: BridgeCallState): boolean {
  return CALL_TRANSITIONS[from].includes(to)
}

export const BRIDGE_CHAT_WORK_STATES = [
  'starting',
  'queued',
  'running',
  'waiting_for_user',
  'idle',
  'error',
  'stopping',
  'stopped',
  'unknown',
] as const
export type BridgeChatWorkState = (typeof BRIDGE_CHAT_WORK_STATES)[number]

/** Per machine. Only an actual stop confirmation produces stopped. */
export const BRIDGE_STOP_STATES = ['pending', 'confirmed', 'unconfirmed'] as const
export type BridgeStopState = (typeof BRIDGE_STOP_STATES)[number]

export const BRIDGE_EVIDENCE_STATUSES = ['measured', 'not_measured', 'unavailable', 'stale'] as const
export type BridgeEvidenceStatus = (typeof BRIDGE_EVIDENCE_STATUSES)[number]

// ─── Errors ─────────────────────────────────────────────────────

export const BRIDGE_ERROR_CODES = [
  'unauthenticated',
  'revoked',
  'bridge_disabled',
  'project_not_allowed',
  'ambiguous_target',
  'chat_archived',
  'chat_not_resumable',
  'child_read_only',
  'mode_not_allowed',
  'agent_unavailable',
  'machine_offline',
  'unsupported_version',
  'rate_limited',
  'idempotency_conflict',
  'request_retired',
  'delivery_unknown',
  'stop_unconfirmed',
  'cursor_expired',
  'policy_denied',
] as const
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

/**
 * `same_key`: retry with the same idempotency key and arguments.
 * `read_first`: read the chat or call before anything else.
 * `ask_owner`: the owner must choose or change something.
 * `none`: retrying does not help.
 */
export type BridgeRetryAdvice = 'same_key' | 'read_first' | 'ask_owner' | 'none'

const DEFAULT_RETRY: Record<BridgeErrorCode, BridgeRetryAdvice> = {
  unauthenticated: 'none',
  revoked: 'none',
  bridge_disabled: 'ask_owner',
  project_not_allowed: 'ask_owner',
  ambiguous_target: 'ask_owner',
  chat_archived: 'ask_owner',
  chat_not_resumable: 'ask_owner',
  child_read_only: 'none',
  mode_not_allowed: 'ask_owner',
  agent_unavailable: 'ask_owner',
  machine_offline: 'ask_owner',
  unsupported_version: 'none',
  rate_limited: 'same_key',
  idempotency_conflict: 'none',
  request_retired: 'none',
  delivery_unknown: 'read_first',
  stop_unconfirmed: 'read_first',
  cursor_expired: 'read_first',
  policy_denied: 'ask_owner',
}

/** Sent as structured MCP output with `isError: true`. The message is safe to show the owner. */
export interface BridgeError {
  code: BridgeErrorCode
  message: string
  call_id: string | null
  retry: BridgeRetryAdvice
  target: BridgeChatRef | { project_id: string } | null
  /** Set on `ambiguous_target`. */
  choices?: BridgeProjectView[] | BridgeChatRef[]
  /** Set on a rejected call: true when the action never reached the machine. */
  non_delivery_confirmed?: boolean
}

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  extra: Partial<Omit<BridgeError, 'code' | 'message'>> = {},
): BridgeError {
  return { code, message, call_id: null, retry: DEFAULT_RETRY[code], target: null, ...extra }
}

// ─── Idempotency ────────────────────────────────────────────────

const SHA256 = /^[0-9a-f]{64}$/

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(object).sort()) {
    if (object[key] !== undefined) output[key] = stableValue(object[key])
  }
  return output
}

/**
 * The bytes a call's input hash covers: the operation and its arguments with
 * keys sorted and undefined dropped. The idempotency key itself is excluded,
 * so the same body under the same key hashes equal.
 */
export function canonicalBridgeInput(operation: BridgeOperation, args: Record<string, unknown>): string {
  const { idempotency_key: _key, ...body } = args
  return JSON.stringify(stableValue({ operation, args: body }))
}

/** Each side supplies its own SHA-256. */
export function bridgeInputHash(
  operation: BridgeOperation,
  args: Record<string, unknown>,
  sha256: (canonical: string) => string,
): string {
  const digest = sha256(canonicalBridgeInput(operation, args)).toLowerCase()
  if (!SHA256.test(digest)) throw new Error('Bridge input hash must be a SHA-256 hex value')
  return digest
}
