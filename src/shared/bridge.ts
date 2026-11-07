/**
 * The Instinct bridge contract: the owner's assistant (Instinct) finds,
 * starts, messages, reads and stops managed chats in the projects the owner
 * allows, through a relay. This file holds the wire version, the tool names,
 * the project policy, the public shapes, the states and the error codes. Main
 * and the relay share it; it has no runtime dependency. The measured
 * evidence section holds the check definitions and the fact shapes
 * `read_chat` returns beside the agent's own reply.
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
  /** The checks the owner chose for this project. Empty means every check stays `not_measured`. */
  checks: BridgeCheckDefinition[]
}

/**
 * The policy as a public answer carries it: no local root, and the checks by
 * NAME only, since a program or an argument can name a path on this Mac.
 */
export type BridgeProjectView = Omit<BridgeProjectPolicy, 'canonical_local_root' | 'checks'> & {
  check_names: string[]
}

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
    checks: [],
  }
}

export function publicProjectView(policy: BridgeProjectPolicy): BridgeProjectView {
  const { canonical_local_root: _root, checks, ...view } = policy
  return { ...view, check_names: checks.map((c) => c.name) }
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

/** One allowed project's checks on the desktop's setup list (`bridge:list-checks`). */
export interface BridgeProjectChecksRow {
  project_id: string
  label: string
  checks: BridgeCheckDefinition[]
  /** The newest recorded run per check name, measured or not. */
  results: BridgeCheckResultRow[]
}

export interface BridgeCheckResultRow {
  name: string
  status: BridgeEvidenceStatus
  outcome: BridgeCheckOutcome
  exit_code: number | null
  /** When the run ended, epoch ms; null while it has no result. */
  at: number | null
}

export interface BridgeChecksSetup {
  enabled: boolean
  projects: BridgeProjectChecksRow[]
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

/**
 * On a chat list row (`SessionSummary.bridgeOrigin`): the chat was started or
 * messaged through the bridge. `checks` is the measured-check evidence the
 * desktop has recorded for it; absent when the backend sent none.
 */
export interface BridgeOriginMarker {
  stop: BridgeOriginStopState | null
  checks?: BridgeCheckSummary
}

const ORIGIN_STOP_STATES: ReadonlySet<unknown> = new Set(BRIDGE_ORIGIN_STOP_STATES)

/** A chat row's `bridgeOrigin` as a phone reads it: a marker, or undefined for anything else (an older backend sends none). */
export function parseBridgeOriginMarker(value: unknown): BridgeOriginMarker | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const stop = (value as { stop?: unknown }).stop
  const checks = parseBridgeCheckSummary((value as { checks?: unknown }).checks)
  const rest = checks ? { checks } : {}
  if (stop === null || stop === undefined) return { stop: null, ...rest }
  return ORIGIN_STOP_STATES.has(stop) ? { stop: stop as BridgeOriginStopState, ...rest } : undefined
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

// ─── Measured evidence ──────────────────────────────────────────
//
// `agent_reply` is what the agent said. `evidence` is what this desktop read
// itself. Agent text, a provider shell transcript and a `report_to_hub`
// result never become evidence: a fact is here only when a recorder on this
// machine observed it, and it says who observed it, when, and about which
// commit or tree.

/**
 * One configured check: a program and an argument ARRAY, never a shell
 * string, so nothing here is parsed by a shell.
 */
export interface BridgeCheckDefinition {
  name: string
  program: string
  args: string[]
}

/** Checks one project may run. A small cap: each one runs after a bridge turn. */
export const BRIDGE_CHECKS_MAX = 4
export const BRIDGE_CHECK_NAME_MAX_CHARS = 60
const BRIDGE_CHECK_ARGS_MAX = 24
const BRIDGE_CHECK_ARG_MAX_CHARS = 200

/** The bytes a definition's hash covers, so a changed program or argument is a different check. */
export function canonicalBridgeCheck(def: BridgeCheckDefinition): string {
  return JSON.stringify([def.name, def.program, def.args])
}

/** A definition the owner may store, or null. A shell metacharacter in the program is refused. */
export function parseBridgeCheckDefinition(value: unknown): BridgeCheckDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { name, program, args } = value as { name?: unknown; program?: unknown; args?: unknown }
  if (typeof name !== 'string' || typeof program !== 'string') return null
  const trimmedName = name.trim()
  const trimmedProgram = program.trim()
  if (!trimmedName || trimmedName.length > BRIDGE_CHECK_NAME_MAX_CHARS) return null
  if (!trimmedProgram || /[\s;&|<>$`'"\\]/.test(trimmedProgram)) return null
  if (!Array.isArray(args) || args.length > BRIDGE_CHECK_ARGS_MAX) return null
  if (!args.every((a) => typeof a === 'string' && a.length > 0 && a.length <= BRIDGE_CHECK_ARG_MAX_CHARS)) return null
  return { name: trimmedName, program: trimmedProgram, args: [...(args as string[])] }
}

/** The stored list for one project: valid definitions, unique by name, at most `BRIDGE_CHECKS_MAX`. */
export function parseBridgeCheckDefinitions(value: unknown): BridgeCheckDefinition[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const checks: BridgeCheckDefinition[] = []
  for (const entry of value) {
    const def = parseBridgeCheckDefinition(entry)
    if (!def || seen.has(def.name)) continue
    seen.add(def.name)
    checks.push(def)
    if (checks.length === BRIDGE_CHECKS_MAX) break
  }
  return checks
}

/** What a measured run ended as. `not_run` covers a cancelled or still scheduled one. */
export const BRIDGE_CHECK_OUTCOMES = ['passed', 'failed', 'not_run', 'unavailable'] as const
export type BridgeCheckOutcome = (typeof BRIDGE_CHECK_OUTCOMES)[number]

/** Who observed a fact. Only a recorder on this machine, never a provider or an agent. */
export type BridgeEvidenceProducer = 'git' | 'pull_request_service' | 'local_check'

export interface BridgeEvidenceFact {
  producer: BridgeEvidenceProducer
  status: BridgeEvidenceStatus
  observed_at: string
  /** The commit the fact is about; null when it is about a dirty tree with no commit of its own. */
  commit: string | null
  /** The git tree the fact is about. */
  tree: string | null
}

/** The checkout the chat runs in, read with git. */
export interface BridgeCodeEvidence extends BridgeEvidenceFact {
  producer: 'git'
  branch: string | null
  dirty: boolean
  /** The tree recorded when the last bridge call reached this chat. */
  baseline_tree: string | null
  /** Files that differ from that baseline; null when there is no baseline to compare with. */
  changed_files: number | null
  /** The chat's execution root revision (`conversations.execution_root_revision`). */
  execution_root_revision: number | null
  /**
   * `bridge_chat` only when this chat is the only one rooted at the checkout.
   * A shared checkout is `unknown`: nothing here proves who wrote a file.
   */
  attribution: 'bridge_chat' | 'unknown'
  /** Plain words for the owner, for example that the tree is dirty with no new commit. */
  note: string
}

/** A pull request linked to the chat, read through the existing pull request service. */
export interface BridgePrEvidence extends BridgeEvidenceFact {
  producer: 'pull_request_service'
  url: string | null
  number: number
  source_branch: string | null
  state: 'open' | 'merged' | 'closed' | null
  /** The head the host reported; `stale` when it is not the commit this checkout is on. */
  head_commit: string | null
  checks: { state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failed: number } | null
  note: string
}

/** One run of a configured check by the local measured-check service. */
export interface BridgeCheckEvidence extends BridgeEvidenceFact {
  producer: 'local_check'
  name: string
  definition_hash: string
  outcome: BridgeCheckOutcome
  /** The process's real exit code, or null when it was killed or never ran. */
  exit_code: number | null
  signal: string | null
  started_at: string | null
  ended_at: string | null
  /** SHA-256 of the masked output, or null when no output was captured. */
  log_digest: string | null
  log_bytes: number | null
  tree_before: string | null
  tree_after: string | null
  /** The run measured a dirty tree, so it is bound to that snapshot and not to a commit. */
  dirty: boolean
  /** The chat changed a file the check definition names, so this is not the configured release check. */
  definition_changed: boolean
  note: string
}

/**
 * A group of measured facts. `items` holds the newest ones only, so one read
 * always fits a relay frame; `omitted` counts the older ones left out, which
 * were never read, so the status speaks for `items` alone.
 */
export interface BridgeEvidenceGroup<T> {
  status: BridgeEvidenceStatus
  items: T[]
  omitted: number
}

export interface BridgeEvidence {
  code: BridgeCodeEvidence
  pull_requests: BridgeEvidenceGroup<BridgePrEvidence>
  checks: BridgeEvidenceGroup<BridgeCheckEvidence>
}

/** Nothing was read: every fact is `not_measured`, never a claim of success. */
export function emptyBridgeEvidence(observedAt: string): BridgeEvidence {
  return {
    code: {
      producer: 'git',
      status: 'not_measured',
      observed_at: observedAt,
      commit: null,
      tree: null,
      branch: null,
      dirty: false,
      baseline_tree: null,
      changed_files: null,
      execution_root_revision: null,
      attribution: 'unknown',
      note: 'The checkout was not read.',
    },
    pull_requests: { status: 'not_measured', items: [], omitted: 0 },
    checks: { status: 'not_measured', items: [], omitted: 0 },
  }
}

/**
 * How many pull requests and checks one read measures. A chat can link
 * hundreds of pull requests; reading them all costs one host call each and
 * makes an answer the relay cannot carry, so a read takes the newest ones.
 */
export const BRIDGE_EVIDENCE_PR_MAX = 10
export const BRIDGE_EVIDENCE_CHECK_MAX = 20

/**
 * The worst status wins, so one unread fact never reads as a measured whole.
 * A fact that could not be read beats one that was never taken, which beats
 * one taken on other code.
 */
export function rollUpBridgeEvidence(statuses: readonly BridgeEvidenceStatus[]): BridgeEvidenceStatus {
  if (statuses.length === 0) return 'not_measured'
  for (const worst of ['unavailable', 'not_measured', 'stale'] as const) if (statuses.includes(worst)) return worst
  return 'measured'
}

/**
 * What a chat list shows about a bridge chat's checks. Recorded runs only.
 * A list reads no checkout, so `measured` needs a backend that knew the tree
 * the chat is on now; anything else is `stale`, as `read_chat` would say of
 * a checkout it did not read.
 */
export interface BridgeCheckSummary {
  status: BridgeEvidenceStatus
  passed: number
  failed: number
}

const EVIDENCE_STATUSES: ReadonlySet<unknown> = new Set(BRIDGE_EVIDENCE_STATUSES)

/** A chat row's check summary as a phone reads it; undefined for anything it cannot read. */
export function parseBridgeCheckSummary(value: unknown): BridgeCheckSummary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { status, passed, failed } = value as { status?: unknown; passed?: unknown; failed?: unknown }
  if (!EVIDENCE_STATUSES.has(status)) return undefined
  const count = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null)
  const ok = count(passed)
  const bad = count(failed)
  if (ok === null || bad === null) return undefined
  return { status: status as BridgeEvidenceStatus, passed: ok, failed: bad }
}

export function bridgeChecksLabel(summary: BridgeCheckSummary): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  switch (summary.status) {
    case 'measured':
      return summary.failed > 0
        ? `${count(summary.failed, 'check')} failed`
        : `${count(summary.passed, 'check')} passed`
    case 'stale':
      return 'Checks not measured on this code'
    case 'unavailable':
      return 'Checks could not run'
    default:
      return 'Checks not measured'
  }
}

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
