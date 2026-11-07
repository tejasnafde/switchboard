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

/** One sidebar project on the desktop's setup list (`bridge:list-projects`). Desktop only: it holds the path. */
export interface BridgeProjectSetupRow {
  path: string
  name: string
  allowed: boolean
  /** Null when the folder no longer resolves. */
  projectId: string | null
  /** An allowed policy no sidebar project resolves to; `path` is its stored root. */
  orphan: boolean
}

export interface BridgeProjectSetup {
  /** The flag is on; while it is off the list is empty and nothing can be switched. */
  enabled: boolean
  projects: BridgeProjectSetupRow[]
}

// ─── Device connection (desktop to relay) ───────────────────────

/** The capability a desktop names in its hello. The relay refuses a hello without it. */
export const BRIDGE_DEVICE_CAPABILITY = 'instinct_bridge_v1'
export const DEFAULT_BRIDGE_RELAY_ORIGIN = 'https://bridge.tn07.dev'

/**
 * The bytes a desktop signs to answer the relay's challenge: the nonce, the
 * machine id and the relay origin, so a signature for one relay or one
 * socket is no use on another. The relay (tn07-site
 * workers/bridge-relay/src/devices.js `helloPayload`) builds the same string.
 */
export function bridgeHelloPayload(input: {
  origin: string
  machineId: string
  nonce: string
  wireVersion?: number
}): string {
  return [
    'switchboard-bridge-hello',
    `v${input.wireVersion ?? BRIDGE_WIRE_VERSION}`,
    input.origin,
    input.machineId,
    input.nonce,
  ].join('\n')
}

/** One allowed project as the desktop publishes it to the relay. No path, ever. */
export interface BridgeCatalogProject {
  project_id: string
  label: string
  default_agent: AgentType | null
  agents: AgentType[]
  maximum_mode: RuntimeMode
}

/**
 * `off`: the flag is off. `not_enrolled`: no device key on this installation.
 * `rejected`: the relay closed the connection with `code`, retried later.
 * `retrying`: the connection dropped (`code` says why), retried later.
 * `key_unreadable`: the stored key cannot be decrypted here.
 */
export type BridgeLinkState =
  | 'off'
  | 'not_enrolled'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'rejected'
  | 'key_unreadable'

/** Settings > Labs, this desktop's enrollment (`bridge:device-status`). Desktop only. */
export interface BridgeDeviceStatus {
  enabled: boolean
  enrolled: boolean
  machine_id: string
  label: string | null
  /** SPKI DER, base64. The public half only. */
  public_key: string | null
  /** The first 16 hex characters of the public key's SHA-256, as the relay lists it. */
  key_fingerprint: string | null
  relay_origin: string | null
  state: BridgeLinkState
  code: string | null
  connection_generation: number | null
  /** The command the operator runs to register this desktop, or null when not enrolled. */
  operator_command: string | null
}

// ─── Stop controls ──────────────────────────────────────────────

/** Bridge work the relay started stops when the relay has been silent this long. */
export const BRIDGE_CONTROL_LEASE_MS = 120_000

/** The relay's stop state, from its welcome and its `control` frames. */
export interface BridgeControl {
  stop_generation: number
  killed: boolean
}

/** A valid control, or null: a generation is a safe integer >= 0 and killed a boolean. */
export function parseBridgeControl(input: { stop_generation?: unknown; killed?: unknown }): BridgeControl | null {
  const generation = input.stop_generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null
  if (typeof input.killed !== 'boolean') return null
  return { stop_generation: generation, killed: input.killed }
}

/** The result of the last stop of all bridge work on this desktop. */
export interface BridgeStopResult {
  generation: number
  state: 'confirmed' | 'unconfirmed'
  /** Root ids of the chats whose stop could not be confirmed. */
  unconfirmed: string[]
  stopped: number
  at: number
}

/** Settings > Labs, the stop controls (`bridge:stop-status`). Desktop only. */
export interface BridgeStopStatus {
  killed: boolean
  stop_generation: number
  /** This desktop's kill has not reached the relay yet. */
  kill_pending: boolean
  enrolled: boolean
  last_result: (BridgeStopResult & { unconfirmed_titles: string[] }) | null
  /** Chats with a bridge origin that run a turn, start or hold bridge-queued messages. */
  active_chats: number
  /** Last frame from the relay in this run of the app, epoch ms. */
  last_contact_at: number | null
  /** When bridge work the relay started stops if the relay stays silent. */
  lease_expires_at: number | null
  /** What clears the kill: the operator command when enrolled, else the local button. */
  clear_command: string | null
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

/**
 * A stop's state on one chat with a bridge origin, for the chat lists:
 * `pending` while its stop runs, `stopped` once it has no turn left,
 * `unconfirmed` when that could not be shown. Null: no stop since its last
 * bridge call.
 */
export const BRIDGE_ORIGIN_STOP_STATES = ['pending', 'stopped', 'unconfirmed'] as const
export type BridgeOriginStopState = (typeof BRIDGE_ORIGIN_STOP_STATES)[number]

/** On a chat list row (`SessionSummary.bridgeOrigin`): the chat was started or messaged through the bridge. */
export interface BridgeOriginMarker {
  stop: BridgeOriginStopState | null
}

const ORIGIN_STOP_STATES: ReadonlySet<unknown> = new Set(BRIDGE_ORIGIN_STOP_STATES)

/** A chat row's `bridgeOrigin` as a phone reads it: a marker, or undefined for anything else (an older backend sends none). */
export function parseBridgeOriginMarker(value: unknown): BridgeOriginMarker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const stop = (value as { stop?: unknown }).stop
  if (stop === null || stop === undefined) return { stop: null }
  return ORIGIN_STOP_STATES.has(stop) ? { stop: stop as BridgeOriginStopState } : undefined
}

/** The short label a chat list shows on a bridge chat. */
export function bridgeOriginLabel(marker: BridgeOriginMarker): string {
  switch (marker.stop) {
    case 'pending':
      return 'Bridge stop pending'
    case 'stopped':
      return 'Bridge stopped'
    case 'unconfirmed':
      return 'Bridge stop not confirmed'
    default:
      return 'From the bridge'
  }
}

/** Adds `bridgeOrigin` to the rows of chats with a bridge origin; other rows are returned as they are. */
export function withBridgeOrigins<T extends { id: string; bridgeOrigin?: BridgeOriginMarker }>(
  sessions: T[],
  markers: ReadonlyMap<string, BridgeOriginMarker>,
): T[] {
  if (markers.size === 0) return sessions
  return sessions.map((s) => {
    const marker = markers.get(s.id)
    return marker ? { ...s, bridgeOrigin: marker } : s
  })
}

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
  'killed',
  'invalid_request',
  'internal_error',
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
  killed: 'ask_owner',
  invalid_request: 'none',
  internal_error: 'none',
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
  /** Set on `agent_unavailable`: what the project allows instead. */
  agent_choices?: AgentType[]
  model_choices?: string[]
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
  // Entries, not assignment: an own `__proto__` key stays a key.
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, stableValue(object[key])]),
  )
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
