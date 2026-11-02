/**
 * Children on other machines, after the start: what the desktop asks a child
 * machine (view, read, deliver, interrupt, stop, move, stop-all) and what it
 * answers. Pure: both ends parse every request and answer here.
 *
 * Every request names the desktop's install id and the parent stub (or the
 * child): the child machine acts only on a child whose parent stub has that
 * `remote_hub`. Capability `hub_remote_control_v1`; a machine without it keeps
 * the "comes in a later version" texts.
 */
import type { ChildState, HubChildPhase, HubSettleRowView, HubWakeKind } from './hub'
import { isHubOutboxId } from './hub-remote'
import type { LimitState } from './limit-resume'
import { peerMessageTooLarge } from './peer-messaging'
import { RUNTIME_MODES, type RuntimeMode } from './provider-events'
import type { TurnDelivery } from './turn-delivery'

/** The backend answers `hub-remote:view`, `read-child`, `deliver`, `interrupt`, `stop`, `move` and `stop-all`. */
export const HUB_REMOTE_CONTROL_CAPABILITY = 'hub_remote_control_v1'

/** A cached view of a machine is read again on a list call when it is older than this. */
export const HUB_REMOTE_VIEW_MAX_AGE_MS = 15_000
/** `hub-remote:children-changed` is sent at most this often per machine. */
export const HUB_REMOTE_CHANGED_COALESCE_MS = 500
/** A `read_child` answer longer than this is refused on the desktop. */
export const HUB_REMOTE_READ_MAX = 1024 * 1024
/** Children in one view answer. */
export const HUB_REMOTE_VIEW_MAX_CHILDREN = 64
/** Parent ids in one `hub-remote:children-changed` event. */
export const HUB_REMOTE_CHANGED_MAX_IDS = 64
/** Blockers kept from one settle row off the wire. */
const BLOCKERS_MAX = 16
const LABEL_MAX = 200
const TEXT_MAX = 16 * 1024

export const HUB_REMOTE_MOVE_OTHER_MACHINE_TEXT = 'A child moves between accounts on its own machine only.'
export const HUB_REMOTE_NOT_OWN_TEXT = 'That is not a child of this hub on this machine.'

/** "Stopping on <machine>": a Stop, settle or stop-all waits to be sent or answered there. */
export const hubRemoteStoppingText = (machine: string): string => `Stopping on ${machine}`

// ─── Requests ───────────────────────────────────────────────────

interface Base {
  v: 1
  desktopInstallId: string
}

export interface HubRemoteViewRequest extends Base {
  parentId: string
}
export interface HubRemoteChildRequest extends Base {
  childId: string
}
export interface HubRemoteReadRequest extends HubRemoteChildRequest {
  /** The `read_child` arguments other than `childId`, as the parent's agent sent them. */
  args: { at?: string; offset?: number; limit?: number; query?: string }
}
export interface HubRemoteDeliverRequest extends HubRemoteChildRequest {
  text: string
  delivery: TurnDelivery
  /** The parent chat's title: the child reads the message as from it. */
  fromLabel: string
}
export interface HubRemoteStopRequest extends HubRemoteChildRequest {
  /** The parent's Stop rather than the user's: the child's wake says it stopped with its parent. */
  cascade?: true
  /** A settle: the child machine's settle rules decide its worktree, with the parent's HEAD (null: unknown, kept). */
  settle?: { parentHead: string | null }
}
export interface HubRemoteMoveRequest extends HubRemoteChildRequest {
  instanceId: string
  parentMode: RuntimeMode
}
export type HubRemoteStopAllRequest = HubRemoteViewRequest

type Parsed<T> = { ok: true; request: T } | { ok: false; message: string }

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

function base(value: unknown, what: string): Parsed<Record<string, unknown> & Base> {
  if (!value || typeof value !== 'object') return { ok: false, message: `The ${what} has an invalid body.` }
  const r = value as Record<string, unknown>
  if (r.v !== 1) return { ok: false, message: `The ${what} has an invalid version.` }
  if (!isHubOutboxId(r.desktopInstallId)) return { ok: false, message: `The ${what} has an invalid desktopInstallId.` }
  return { ok: true, request: r as Record<string, unknown> & Base }
}

const invalid = (what: string, field: string) => ({
  ok: false as const,
  message: `The ${what} has an invalid ${field}.`,
})

function oneLineLabel(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= LABEL_MAX && !/[\x00-\x1f\x7f]/.test(v) ? v : null
}

export function parseHubRemoteViewRequest(value: unknown, what = 'view request'): Parsed<HubRemoteViewRequest> {
  const b = base(value, what)
  if (!b.ok) return b
  if (!isHubOutboxId(b.request.parentId)) return invalid(what, 'parentId')
  return { ok: true, request: { v: 1, desktopInstallId: b.request.desktopInstallId, parentId: b.request.parentId } }
}

export function parseHubRemoteChildRequest(value: unknown, what: string): Parsed<HubRemoteChildRequest> {
  const b = base(value, what)
  if (!b.ok) return b
  if (!isHubOutboxId(b.request.childId)) return invalid(what, 'childId')
  return { ok: true, request: { v: 1, desktopInstallId: b.request.desktopInstallId, childId: b.request.childId } }
}

export function parseHubRemoteReadRequest(value: unknown): Parsed<HubRemoteReadRequest> {
  const what = 'read request'
  const c = parseHubRemoteChildRequest(value, what)
  if (!c.ok) return c
  const raw = (value as Record<string, unknown>).args
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return invalid(what, 'args')
  const a = (raw ?? {}) as Record<string, unknown>
  const args: HubRemoteReadRequest['args'] = {}
  if (a.at !== undefined) {
    if (typeof a.at !== 'string' || a.at.length > LABEL_MAX) return invalid(what, 'at')
    args.at = a.at
  }
  if (a.query !== undefined) {
    if (typeof a.query !== 'string' || a.query.length > LABEL_MAX) return invalid(what, 'query')
    args.query = a.query
  }
  for (const k of ['offset', 'limit'] as const) {
    if (a[k] === undefined) continue
    const n = a[k]
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return invalid(what, k)
    args[k] = n
  }
  return { ok: true, request: { ...c.request, args } }
}

export function parseHubRemoteDeliverRequest(value: unknown): Parsed<HubRemoteDeliverRequest> {
  const what = 'deliver request'
  const c = parseHubRemoteChildRequest(value, what)
  if (!c.ok) return c
  const r = value as Record<string, unknown>
  if (typeof r.text !== 'string' || !r.text.trim() || peerMessageTooLarge(r.text) !== null) return invalid(what, 'text')
  if (r.delivery !== 'queue' && r.delivery !== 'steer') return invalid(what, 'delivery')
  const fromLabel = oneLineLabel(r.fromLabel)
  if (!fromLabel) return invalid(what, 'fromLabel')
  return { ok: true, request: { ...c.request, text: r.text, delivery: r.delivery, fromLabel } }
}

export function parseHubRemoteStopRequest(value: unknown): Parsed<HubRemoteStopRequest> {
  const what = 'stop request'
  const c = parseHubRemoteChildRequest(value, what)
  if (!c.ok) return c
  const r = value as Record<string, unknown>
  if (r.cascade !== undefined && r.cascade !== true) return invalid(what, 'cascade')
  const request: HubRemoteStopRequest = { ...c.request, ...(r.cascade ? { cascade: true as const } : {}) }
  const s = r.settle
  if (s === undefined) return { ok: true, request }
  if (!s || typeof s !== 'object') return invalid(what, 'settle')
  const head = (s as Record<string, unknown>).parentHead
  if (head !== null && (typeof head !== 'string' || !SHA_RE.test(head))) return invalid(what, 'parentHead')
  return { ok: true, request: { ...request, settle: { parentHead: head } } }
}

export function parseHubRemoteMoveRequest(value: unknown): Parsed<HubRemoteMoveRequest> {
  const what = 'move request'
  const c = parseHubRemoteChildRequest(value, what)
  if (!c.ok) return c
  const r = value as Record<string, unknown>
  if (!isHubOutboxId(r.instanceId)) return invalid(what, 'instanceId')
  if (typeof r.parentMode !== 'string' || !(RUNTIME_MODES as readonly string[]).includes(r.parentMode))
    return invalid(what, 'parentMode')
  return {
    ok: true,
    request: { ...c.request, instanceId: r.instanceId, parentMode: r.parentMode as RuntimeMode },
  }
}

/**
 * Where a `move_child` target account is, for a child on `machineId`:
 * `here` (listed by that machine), `elsewhere` (an account of this desktop or
 * of another machine: refused, `HUB_REMOTE_MOVE_OTHER_MACHINE_TEXT`), or
 * `unknown` (that machine is asked, and refuses an id it does not have).
 */
export function hubMoveTargetPlace(m: {
  targetId: string
  machineId: string
  /** Account ids per machine, from each machine's last description. */
  accounts: ReadonlyArray<{ machineId: string; instanceIds: readonly string[] }>
  /** The id is an account of this desktop. */
  localAccount: boolean
}): 'here' | 'elsewhere' | 'unknown' {
  if (m.accounts.some((a) => a.machineId === m.machineId && a.instanceIds.includes(m.targetId))) return 'here'
  if (m.localAccount || m.accounts.some((a) => a.machineId !== m.machineId && a.instanceIds.includes(m.targetId)))
    return 'elsewhere'
  return 'unknown'
}

// ─── Answers ────────────────────────────────────────────────────

/** Why the child machine did not act. `not_found`: no such child there (a stop of it is done). */
export type HubRemoteRefusalCode = 'not_found' | 'not_own' | 'invalid' | 'failed'

export type HubRemoteActAnswer = { v: 1; ok: true } | { v: 1; ok: false; code: HubRemoteRefusalCode; message: string }

export type HubRemoteInterruptAnswer = { v: 1; ok: true; ran: boolean } | Extract<HubRemoteActAnswer, { ok: false }>

export type HubRemoteStopAnswer =
  | { v: 1; ok: true; ran: boolean; settled?: HubSettleRowView }
  | Extract<HubRemoteActAnswer, { ok: false }>

/** read_child and move_child: the tool result the child machine's own tool gave. */
export type HubRemoteToolAnswer =
  | { v: 1; ok: true; text: string; isError: boolean }
  | Extract<HubRemoteActAnswer, { ok: false }>

export interface HubRemoteStopAllAnswer {
  v: 1
  ok: true
  /** Children of the stub that were open and are stopped now. */
  stopped: number
}

const CODES: readonly HubRemoteRefusalCode[] = ['not_found', 'not_own', 'invalid', 'failed']

export function hubRemoteRefusal(
  code: HubRemoteRefusalCode,
  message: string,
): Extract<HubRemoteActAnswer, { ok: false }> {
  return { v: 1, ok: false, code, message }
}

/** A refusal off the wire, or null when the answer is not one. */
export function parseHubRemoteRefusal(value: unknown): Extract<HubRemoteActAnswer, { ok: false }> | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.v !== 1 || r.ok !== false) return null
  const code = (CODES as readonly string[]).includes(r.code as string) ? (r.code as HubRemoteRefusalCode) : 'failed'
  const message = typeof r.message === 'string' ? r.message.slice(0, TEXT_MAX) : 'The machine refused.'
  return hubRemoteRefusal(code, message)
}

/** An ok answer off the wire with the fields the caller asks for, or null. */
export function parseHubRemoteOk(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  return r.v === 1 && r.ok === true ? r : null
}

export function parseHubRemoteToolAnswer(value: unknown, max = HUB_REMOTE_READ_MAX): HubRemoteToolAnswer | null {
  const refusal = parseHubRemoteRefusal(value)
  if (refusal) return refusal
  const r = parseHubRemoteOk(value)
  if (!r || typeof r.text !== 'string' || r.text.length > max || typeof r.isError !== 'boolean') return null
  return { v: 1, ok: true, text: r.text, isError: r.isError }
}

const WORKTREE_VALUES = ['remove', 'keep', 'none'] as const

/** A settle row from a child machine; the desktop keeps its own title. */
export function parseHubRemoteSettleRow(value: unknown, childId: string, title: string): HubSettleRowView | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const triState = (v: unknown) => v === true || v === false || v === null
  if (!triState(r.merged) || !triState(r.clean)) return null
  if (!(WORKTREE_VALUES as readonly unknown[]).includes(r.worktree)) return null
  if (r.keepReason !== undefined && typeof r.keepReason !== 'string') return null
  return {
    childId,
    title,
    branch: typeof r.branch === 'string' && r.branch.length <= LABEL_MAX ? r.branch : null,
    merged: r.merged as boolean | null,
    clean: r.clean as boolean | null,
    blockers: Array.isArray(r.blockers)
      ? r.blockers
          .filter((b): b is string => typeof b === 'string')
          .slice(0, BLOCKERS_MAX)
          .map((b) => b.slice(0, TEXT_MAX))
      : [],
    worktree: r.worktree as HubSettleRowView['worktree'],
    ...(typeof r.keepReason === 'string' ? { keepReason: r.keepReason.slice(0, LABEL_MAX) } : {}),
  }
}

// ─── View ───────────────────────────────────────────────────────

/** One child as its machine sees it: what the strip and `list_children` show of a local child. */
export interface HubRemoteChildState {
  childId: string
  phase: HubChildPhase
  state: ChildState
  reported?: true
  limit: LimitState['kind']
  waitingForSlot: boolean
  account: string | null
  model: string | null
  mode: RuntimeMode
  branch: string | null
  /** Its worktree there, `~/...` under that machine's home. */
  worktree: string | null
  git: { ahead: number; behind: number; dirty: boolean; diffstat: string } | null
  lastTurn: { usedTokens: number | null; costUsd: number | null } | null
  resources: { rssMb: number; cpuPct: number; processes: number } | null
  diskMb: number | null
  /** The last time its session ran a turn or changed state there (ms), or null. */
  lastActivityAt: number | null
  lastWake: { kind: HubWakeKind; summary: string } | null
  nativeSubagents: { running: number; done: number; failed: number }
}

export interface HubRemoteViewAnswer {
  v: 1
  children: HubRemoteChildState[]
}

const CHILD_STATES: readonly ChildState[] = [
  'settled',
  'starting',
  'needs_you',
  'working',
  'limited',
  'asked_hub',
  'result_ready',
  'blocked',
  'failed',
  'paused',
]
const PHASES: readonly HubChildPhase[] = ['starting', 'open', 'settled', 'failed_start']
const LIMIT_KINDS: readonly LimitState['kind'][] = ['none', 'armed', 'disarmed', 'gave_up', 'no_reset']
const WAKE_KINDS: readonly HubWakeKind[] = [
  'report',
  'question',
  'blocked',
  'failed',
  'stopped',
  'limited',
  'resumed',
  'restart',
]

const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const nullableCount = (v: unknown): v is number | null => v === null || count(v)
const nullableLabel = (v: unknown): v is string | null => v === null || oneLineLabel(v) !== null
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v)

/** One child state off the wire, or null when any field is wrong. */
export function parseHubRemoteChildState(value: unknown): HubRemoteChildState | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (!isHubOutboxId(r.childId) || !oneOf(PHASES, r.phase) || !oneOf(CHILD_STATES, r.state)) return null
  if (!oneOf(LIMIT_KINDS, r.limit) || typeof r.waitingForSlot !== 'boolean') return null
  if (!nullableLabel(r.account) || !nullableLabel(r.model) || !nullableLabel(r.branch)) return null
  if (!oneOf(RUNTIME_MODES, r.mode)) return null
  if (r.worktree !== null && (typeof r.worktree !== 'string' || r.worktree.length > 1024)) return null
  if (!nullableCount(r.diskMb) || !nullableCount(r.lastActivityAt)) return null
  let git: HubRemoteChildState['git'] = null
  if (r.git !== null) {
    const g = r.git as Record<string, unknown>
    if (!g || typeof g !== 'object' || !count(g.ahead) || !count(g.behind) || typeof g.dirty !== 'boolean') return null
    if (typeof g.diffstat !== 'string' || g.diffstat.length > LABEL_MAX) return null
    git = { ahead: g.ahead, behind: g.behind, dirty: g.dirty, diffstat: g.diffstat }
  }
  let lastTurn: HubRemoteChildState['lastTurn'] = null
  if (r.lastTurn !== null) {
    const t = r.lastTurn as Record<string, unknown>
    if (!t || typeof t !== 'object' || !nullableCount(t.usedTokens) || !nullableCount(t.costUsd)) return null
    lastTurn = { usedTokens: t.usedTokens, costUsd: t.costUsd }
  }
  let resources: HubRemoteChildState['resources'] = null
  if (r.resources !== null) {
    const s = r.resources as Record<string, unknown>
    if (!s || typeof s !== 'object' || !count(s.rssMb) || !count(s.cpuPct) || !count(s.processes)) return null
    resources = { rssMb: s.rssMb, cpuPct: s.cpuPct, processes: s.processes }
  }
  let lastWake: HubRemoteChildState['lastWake'] = null
  if (r.lastWake !== null) {
    const w = r.lastWake as Record<string, unknown>
    if (!w || typeof w !== 'object' || !oneOf(WAKE_KINDS, w.kind) || typeof w.summary !== 'string') return null
    lastWake = { kind: w.kind, summary: w.summary.slice(0, TEXT_MAX) }
  }
  const n = r.nativeSubagents as Record<string, unknown>
  if (!n || typeof n !== 'object' || !count(n.running) || !count(n.done) || !count(n.failed)) return null
  return {
    childId: r.childId,
    phase: r.phase,
    state: r.state,
    ...(r.reported === true ? { reported: true as const } : {}),
    limit: r.limit,
    waitingForSlot: r.waitingForSlot,
    account: r.account,
    model: r.model,
    mode: r.mode,
    branch: r.branch,
    worktree: r.worktree as string | null,
    git,
    lastTurn,
    resources,
    diskMb: r.diskMb,
    lastActivityAt: r.lastActivityAt,
    lastWake,
    nativeSubagents: { running: n.running, done: n.done, failed: n.failed },
  }
}

/** A view answer off the wire: malformed children are left out, a malformed body is null. */
export function parseHubRemoteViewAnswer(value: unknown): HubRemoteViewAnswer | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.children) || r.children.length > HUB_REMOTE_VIEW_MAX_CHILDREN) return null
  return {
    v: 1,
    children: r.children.map(parseHubRemoteChildState).filter((c): c is HubRemoteChildState => c !== null),
  }
}

/** `/home/u/x` as `~/x` when it is under `home`; anything else as it is. */
export function homeRelative(path: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  if (!h) return path
  if (path === h) return '~'
  return path.startsWith(`${h}/`) ? `~/${path.slice(h.length + 1)}` : path
}
