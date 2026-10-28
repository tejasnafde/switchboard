/**
 * Child chats ("hub"): the pure rules.
 *
 * Any chat can start children. A chat is a child while `hub_children` has an
 * open row for it, and a parent while rows name it as `parent_id`; neither is
 * a chat type. Children report through small wake rows (a summary and a
 * pointer into the child's own transcript), delivered to the parent as one
 * batched turn while it is idle.
 */
import type { RuntimeMode } from './provider-events'
import { RUNTIME_MODES } from './provider-events'
import type { LimitState, SettingReader } from './limit-resume'
import type { PrLinkChat } from './pull-request-links'
import { isAgentProvider, type AgentProvider } from './types'

/**
 * Staged flag `hub_children`. Off until children ship on every surface.
 * `SB_HUB_CHILDREN=1` in Switchboard's own env, or the labs setting, turns it
 * on for testing.
 */
export const HUB_CHILDREN_ENABLED = false
export const HUB_CHILDREN_LABS_SETTING = 'labs.hub_children'

export function hubChildrenEnabled(env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  return HUB_CHILDREN_ENABLED || env.SB_HUB_CHILDREN === '1' || getSetting(HUB_CHILDREN_LABS_SETTING) === 'true'
}

// ─── Stored shapes ──────────────────────────────────────────────

export type HubChildPhase = 'starting' | 'open' | 'settled' | 'failed_start'
export type HubBatchStatus = 'proposed' | 'approved' | 'denied' | 'withdrawn'
export type HubChildLocation = 'worktree' | 'project'
export type HubDepsMode = 'link' | 'clone' | 'install' | 'none'
export type HubWakeKind = 'report' | 'question' | 'blocked' | 'failed' | 'stopped' | 'limited' | 'resumed' | 'restart'

/** Phases in which a child is read-only for the user and cannot be a parent. */
export function isOpenChildPhase(phase: HubChildPhase): boolean {
  return phase === 'starting' || phase === 'open'
}

/**
 * Where in the child's transcript a wake points. `toolCallId` is the provider's
 * id of the `report_to_hub` call; `messageId` and `at` are fallbacks.
 * `transcriptPath` is the provider file when one exists (ACP chats have none).
 */
export interface HubPointer {
  childId: string
  toolCallId?: string
  messageId?: string
  at: number
  transcriptPath?: string
}

/** A stored `pointer_json`, or null when it is not a pointer. */
export function parseHubPointer(json: string | null): HubPointer | null {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.childId !== 'string' || typeof r.at !== 'number') return null
  const opt = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    childId: r.childId,
    toolCallId: opt(r.toolCallId),
    messageId: opt(r.messageId),
    at: r.at,
    transcriptPath: opt(r.transcriptPath),
  }
}

// ─── Settings ───────────────────────────────────────────────────

/** A numeric backend setting: its key, default and accepted range. */
interface NumberSetting {
  key: string
  defaultValue: number
  min: number
  max: number
  /** Stored as `off`: the feature is turned off (null). */
  allowOff?: boolean
}

export const HUB_SETTINGS = {
  runningPerInstance: { key: 'hub.runningPerInstance', defaultValue: 3, min: 1, max: 8 },
  runningPerParent: { key: 'hub.runningPerParent', defaultValue: 6, min: 1, max: 12 },
  idleReapMinutes: { key: 'hub.idleReapMinutes', defaultValue: 20, min: 5, max: 240, allowOff: true },
  minFreeGiB: { key: 'hub.minFreeGiB', defaultValue: 5, min: 1, max: 50 },
} as const satisfies Record<string, NumberSetting>

export const HUB_CHILD_DEPENDENCIES_SETTING = 'hub.childDependencies'
export const HUB_DEPS_MODES: readonly HubDepsMode[] = ['link', 'clone', 'install', 'none']
/** Fixed in v1, not a setting row. */
export const HUB_OPEN_CHILDREN_MAX = 12

export interface HubSettings {
  runningPerInstance: number
  runningPerParent: number
  /** Null: the idle reaper is off. */
  idleReapMinutes: number | null
  minFreeGiB: number
  childDependencies: HubDepsMode
}

function readNumber(s: NumberSetting, stored: string | null): number | null {
  if (stored === 'off' && s.allowOff) return null
  const n = stored === null ? NaN : Number(stored)
  return Number.isInteger(n) && n >= s.min && n <= s.max ? n : s.defaultValue
}

/** Every hub setting, with the default for a missing or out-of-range row. */
export function readHubSettings(getSetting: SettingReader): HubSettings {
  const deps = getSetting(HUB_CHILD_DEPENDENCIES_SETTING)
  return {
    runningPerInstance: readNumber(HUB_SETTINGS.runningPerInstance, getSetting(HUB_SETTINGS.runningPerInstance.key))!,
    runningPerParent: readNumber(HUB_SETTINGS.runningPerParent, getSetting(HUB_SETTINGS.runningPerParent.key))!,
    idleReapMinutes: readNumber(HUB_SETTINGS.idleReapMinutes, getSetting(HUB_SETTINGS.idleReapMinutes.key)),
    minFreeGiB: readNumber(HUB_SETTINGS.minFreeGiB, getSetting(HUB_SETTINGS.minFreeGiB.key))!,
    childDependencies: HUB_DEPS_MODES.find((m) => m === deps) ?? 'link',
  }
}

// ─── Permissions ────────────────────────────────────────────────

/**
 * A child never gets more access than its parent: the lower of the two modes.
 * The request comes from an agent tool call, so an unknown mode fails closed.
 */
export function grantedMode(requested: RuntimeMode | undefined, parent: RuntimeMode): RuntimeMode {
  const p = RUNTIME_MODES.indexOf(parent)
  if (p < 0) return RUNTIME_MODES[0]!
  if (!requested) return parent
  const r = RUNTIME_MODES.indexOf(requested)
  return r >= 0 && r < p ? requested : parent
}

/**
 * Whether the batch and settle steps ask the user with a card. Only plan and
 * supervised modes ask; auto-accept edits and every mode above it start
 * children and settle safely without a card, and say what they did in a row.
 */
export function hubNeedsCard(parent: RuntimeMode): boolean {
  return parent === 'plan' || parent === 'sandbox'
}

// ─── Run slots ──────────────────────────────────────────────────

/** A child with a turn in flight, or one asking for a slot. */
export interface HubRunningChild {
  providerInstanceId: string
  parentId: string
}

/** Whether `slot` may start a turn next to the children already running. */
export function runSlotFree(
  slot: HubRunningChild,
  running: readonly HubRunningChild[],
  perInstance: number,
  perParent: number,
): boolean {
  const sameInstance = running.filter((r) => r.providerInstanceId === slot.providerInstanceId).length
  const sameParent = running.filter((r) => r.parentId === slot.parentId).length
  return sameInstance < perInstance && sameParent < perParent
}

// ─── Moving a limited child ─────────────────────────────────────

/**
 * Why `move_child` may not move a child to `target` now, or null. The usage
 * reading of the target and its run slot are checked after this, since both
 * need I/O. `agent` and `target.agent` are agent kinds (`claude`, `codex`).
 */
export function moveChildProblem(m: {
  parentMode: RuntimeMode
  limit: LimitState['kind']
  limitedTurnId: string | null
  movedAfterLimitTurnId: string | null
  agent: string
  currentInstanceId: string | null
  targetId: string
  target: { agent: string; enabled: boolean; name: string } | null
}): string | null {
  if (m.parentMode === 'plan') return 'Plan mode does not move child chats.'
  if (m.limit === 'none') return 'The child is not stopped by a usage limit, so it stays on its account.'
  if (m.limitedTurnId !== null && m.limitedTurnId === m.movedAfterLimitTurnId)
    return 'The child was already moved for this limit. It can move again only after a new limit.'
  if (!m.target || !m.target.enabled) return `No enabled account has the id ${m.targetId}.`
  if (m.target.agent !== m.agent)
    return (
      `${m.target.name} is a ${m.target.agent} account and the child runs ${m.agent}. move_child keeps the agent. ` +
      "To go on with another agent, call interrupt_child, then start_children with a brief that sums up the child's " +
      'work and points to its transcript (read_child shows it).'
    )
  if (m.targetId === m.currentInstanceId) return `The child already runs on ${m.target.name}.`
  return null
}

// ─── Shown states ───────────────────────────────────────────────

export type ChildState =
  | 'settled'
  | 'starting'
  | 'needs_you'
  | 'working'
  | 'limited'
  | 'asked_hub'
  | 'result_ready'
  | 'blocked'
  | 'failed'
  | 'paused'

export interface ChildStateInput {
  phase: HubChildPhase
  depsReady: boolean
  waitingForSlot: boolean
  /** The client knows the child's session (it can show it). */
  sessionKnown: boolean
  /** A live, blocking approval or question waits for the user. */
  blockingRequest: boolean
  running: boolean
  nativeSubagentsRunning: boolean
  limit: LimitState['kind']
  lastWake: HubWakeKind | null
  /** The parent messaged the child after its last wake. */
  parentRepliedSinceWake: boolean
}

/**
 * The state a child shows, first match wins. `reported` marks a Working child
 * that already reported while its native subagents still run.
 */
export function childState(c: ChildStateInput): { state: ChildState; reported?: true } {
  if (c.phase === 'settled') return { state: 'settled' }
  if (c.phase === 'failed_start') return { state: 'failed' }
  if (c.phase === 'starting' || !c.depsReady || c.waitingForSlot || !c.sessionKnown) return { state: 'starting' }
  if (c.blockingRequest) return { state: 'needs_you' }
  if (c.running || c.nativeSubagentsRunning) {
    return !c.running && c.lastWake === 'report' ? { state: 'working', reported: true } : { state: 'working' }
  }
  if (c.limit !== 'none') return { state: 'limited' }
  if (c.lastWake === 'question' && !c.parentRepliedSinceWake) return { state: 'asked_hub' }
  if (c.lastWake === 'report') return { state: 'result_ready' }
  if (c.lastWake === 'blocked') return { state: 'blocked' }
  if (c.lastWake === 'failed') return { state: 'failed' }
  return { state: 'paused' }
}

/** `idle`: no child moves and not all are done (paused, blocked, failed). */
export type ParentState = 'working' | 'limited' | 'updates_ready' | 'waiting' | 'done' | 'idle'

/** The state a parent shows, or null when it has no unsettled children. */
export function parentState(p: {
  ownTurnRunning: boolean
  ownLimit: LimitState['kind']
  heldWakes: number
  children: ReadonlyArray<{ state: ChildState; limit: LimitState['kind'] }>
}): ParentState | null {
  const unsettled = p.children.filter((c) => c.state !== 'settled')
  if (unsettled.length === 0) return null
  if (p.ownTurnRunning) return 'working'
  if (p.ownLimit !== 'none') return 'limited'
  if (p.heldWakes > 0) return 'updates_ready'
  const moving = (c: { state: ChildState; limit: LimitState['kind'] }) =>
    c.state === 'starting' ||
    c.state === 'working' ||
    c.state === 'needs_you' ||
    c.state === 'asked_hub' ||
    (c.state === 'limited' && c.limit === 'armed')
  if (unsettled.some(moving)) return 'waiting'
  if (unsettled.every((c) => c.state === 'result_ready')) return 'done'
  return 'idle'
}

// ─── Wakes ──────────────────────────────────────────────────────

/** A wake turn waits this long after the newest wake for more to arrive. */
export const HUB_WAKE_QUIET_MS = 15_000
/** Wake turns per parent per hour; past it the wakes wait for Deliver. */
export const HUB_WAKES_PER_HOUR = 30

export type WakeDecision =
  | { action: 'send' }
  | { action: 'wait'; until: number | null }
  | { action: 'hold'; reason: 'held' | 'budget' }

/**
 * Whether to send the parent one wake turn now. `until` is when to look
 * again; null means on the parent's next idle.
 */
export function wakeBatchDecision(w: {
  pending: number
  newestAt: number
  now: number
  parentIdle: boolean
  held: boolean
  sentInLastHour: number
}): WakeDecision {
  if (w.pending === 0) return { action: 'wait', until: null }
  if (w.held) return { action: 'hold', reason: 'held' }
  if (w.sentInLastHour >= HUB_WAKES_PER_HOUR) return { action: 'hold', reason: 'budget' }
  if (!w.parentIdle) return { action: 'wait', until: null }
  const quietAt = w.newestAt + HUB_WAKE_QUIET_MS
  return w.now < quietAt ? { action: 'wait', until: quietAt } : { action: 'send' }
}

/** A wake turn the provider shows no activity on for this long ends; its wakes stay pending. */
export const HUB_WAKE_NO_START_MS = 120_000
/** Failed tries (a refused send, or no activity) before the wakes are held for Deliver. */
export const HUB_WAKE_MAX_ATTEMPTS = 2

/** What a child reports with `report_to_hub`. */
export type HubReportStatus = 'done' | 'question' | 'blocked'
export const HUB_REPORT_STATUSES: readonly HubReportStatus[] = ['done', 'question', 'blocked']

export function reportWakeKind(status: HubReportStatus): HubWakeKind {
  return status === 'done' ? 'report' : status
}

/** The state a wake puts its child in, for the update turn: the parent reads the rest with list_children. */
export function wakeChildState(kind: HubWakeKind): ChildState {
  switch (kind) {
    case 'report':
      return 'result_ready'
    case 'question':
      return 'asked_hub'
    case 'blocked':
      return 'blocked'
    case 'failed':
      return 'failed'
    case 'limited':
      return 'limited'
    case 'resumed':
      return 'working'
    case 'stopped':
    case 'restart':
      return 'paused'
  }
}

/** One child's line in the parent's `[[sb:hub-update]]` row. */
export interface HubUpdateRowEntry {
  childId: string
  title: string
  kind: HubWakeKind
  summary: string
}

export const HUB_UPDATE_MARKER_PREFIX = '[[sb:hub-update]]'

/** The system row the parent's chat shows for one delivered update. */
export function formatHubUpdateMarker(entries: readonly HubUpdateRowEntry[]): string {
  return `${HUB_UPDATE_MARKER_PREFIX} ${JSON.stringify({ entries })}`
}

const WAKE_KINDS: ReadonlySet<string> = new Set([
  'report',
  'question',
  'blocked',
  'failed',
  'stopped',
  'limited',
  'resumed',
  'restart',
])

/** The entries of a stored `[[sb:hub-update]]` row, or null when it is not one. */
export function parseHubUpdateMarker(content: string): HubUpdateRowEntry[] | null {
  if (!content.startsWith(HUB_UPDATE_MARKER_PREFIX)) return null
  let raw: unknown
  try {
    raw = JSON.parse(content.slice(HUB_UPDATE_MARKER_PREFIX.length))
  } catch {
    return null
  }
  const list = (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) return null
  const entries: HubUpdateRowEntry[] = []
  for (const e of list) {
    const r = e as Record<string, unknown> | null
    if (
      typeof r?.childId !== 'string' ||
      typeof r.title !== 'string' ||
      typeof r.kind !== 'string' ||
      !WAKE_KINDS.has(r.kind) ||
      typeof r.summary !== 'string'
    )
      return null
    entries.push({ childId: r.childId, title: r.title, kind: r.kind as HubWakeKind, summary: r.summary })
  }
  return entries
}

const WAKE_KIND_LABELS: Record<HubWakeKind, string> = {
  report: 'Reported',
  question: 'Asked a question',
  blocked: 'Blocked',
  failed: 'Failed',
  stopped: 'Stopped',
  limited: 'Limited',
  resumed: 'Resumed',
  restart: 'Restarted',
}

export const hubWakeKindLabel = (kind: HubWakeKind): string => WAKE_KIND_LABELS[kind]

// ─── Wrappers ───────────────────────────────────────────────────

export const HUB_BRIEF_OPEN = '<switchboard-hub-brief>'
export const HUB_BRIEF_CLOSE = '</switchboard-hub-brief>'
export const HUB_UPDATE_OPEN = '<switchboard-hub-update>'
export const HUB_UPDATE_CLOSE = '</switchboard-hub-update>'

/** `close` cannot appear inside, so agent text cannot end the block early and pass as the user's words. */
const without = (close: string) => (s: string) => s.split(close).join(`${close.slice(0, -1)} >`)
const safeBrief = without(HUB_BRIEF_CLOSE)
const safeUpdate = without(HUB_UPDATE_CLOSE)

/** Appended to every brief, so a child knows how to reach its parent. */
export const HUB_REPORT_LINE =
  'When you finish, have a question for your parent chat, or are blocked, call report_to_hub with a short summary.'

/** A child's first turn: the parent's brief, wrapped so it carries no user authority. */
export function hubBriefTurn(brief: string): string {
  return `${HUB_BRIEF_OPEN}\n${safeBrief(brief)}\n${HUB_BRIEF_CLOSE}`
}

export interface HubUpdateEntry {
  title: string
  state: ChildState
  summary: string
  pointer: HubPointer | null
}

/** One wake turn for the parent: per child its state, summary and where to read more. */
export function hubUpdateTurn(entries: readonly HubUpdateEntry[]): string {
  const blocks = entries.map((e) => {
    const lines = [safeUpdate(`${e.title} (${e.state}): ${e.summary}`)]
    if (e.pointer) {
      const at = e.pointer.toolCallId ?? e.pointer.messageId
      lines.push(
        `read_child { childId: ${JSON.stringify(e.pointer.childId)}${at ? `, at: ${JSON.stringify(at)}` : ''} }`,
      )
      if (e.pointer.transcriptPath) lines.push(safeUpdate(`transcript: ${e.pointer.transcriptPath}`))
    }
    return lines.join('\n')
  })
  return `${HUB_UPDATE_OPEN}\n${blocks.join('\n\n')}\n${HUB_UPDATE_CLOSE}`
}

// ─── Starting children ──────────────────────────────────────────

/** Tasks one `start_children` call may hold. */
export const HUB_MAX_TASKS_PER_BATCH = 8

/** The backend refuses a user turn to an open child with this code. */
export const CHILD_READ_ONLY_CODE = 'child_read_only'
export const CHILD_READ_ONLY_TEXT = 'This chat belongs to a hub. Message the hub.'

/** One child as the parent asked for it. `agent` is an agent type; `account` a provider instance id. */
export interface HubTask {
  title: string
  brief: string
  location: HubChildLocation
  baseRef?: string
  branch?: string
  agent?: AgentProvider
  account?: string
  model?: string
  mode?: RuntimeMode
}

const TITLE_MAX = 120
const BRIEF_MAX = 32 * 1024

/** The tasks of a `start_children` call, or why they are refused. Agent input, so every field is checked. */
export function parseHubTasks(raw: unknown): { ok: true; tasks: HubTask[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > HUB_MAX_TASKS_PER_BATCH)
    return { ok: false, message: `Give 1 to ${HUB_MAX_TASKS_PER_BATCH} tasks.` }
  const tasks: HubTask[] = []
  for (const [i, item] of raw.entries()) {
    const n = `Task ${i + 1}`
    if (typeof item !== 'object' || item === null) return { ok: false, message: `${n} is not an object.` }
    const t = item as Record<string, unknown>
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const title = str(t.title)
    const brief = str(t.brief)
    if (!title || title.length > TITLE_MAX)
      return { ok: false, message: `${n} needs a title of 1 to ${TITLE_MAX} characters.` }
    if (!brief || brief.length > BRIEF_MAX) return { ok: false, message: `${n} needs a brief of at most 32 KiB.` }
    const location = t.location ?? 'worktree'
    if (location !== 'worktree' && location !== 'project')
      return { ok: false, message: `${n}: location is "worktree" or "project".` }
    const agentRaw = str(t.agent)
    const agent = agentRaw === 'claude' ? 'claude-code' : agentRaw
    if (agent !== undefined && !isAgentProvider(agent))
      return { ok: false, message: `${n}: unknown agent "${agentRaw}".` }
    const mode = str(t.mode)
    if (mode !== undefined && !(RUNTIME_MODES as readonly string[]).includes(mode))
      return { ok: false, message: `${n}: mode is one of ${RUNTIME_MODES.join(', ')}.` }
    const branch = str(t.branch)
    if (branch !== undefined && !/^[A-Za-z0-9._/-]{1,80}$/.test(branch))
      return { ok: false, message: `${n}: branch may hold letters, digits, ".", "_", "-" and "/" only.` }
    const task: HubTask = { title, brief, location }
    const baseRef = str(t.baseRef)
    const account = str(t.account)
    const model = str(t.model)
    if (baseRef) task.baseRef = baseRef
    if (branch) task.branch = branch
    if (agent) task.agent = agent
    if (account) task.account = account
    if (model) task.model = model
    if (mode) task.mode = mode as RuntimeMode
    tasks.push(task)
  }
  return { ok: true, tasks }
}

/** One row of the batch card. */
export interface HubBatchRowView {
  title: string
  agent: AgentProvider
  account: string | null
  model: string | null
  mode: RuntimeMode
  location: HubChildLocation
  baseRef: string
  deps: HubDepsMode
}

/** What the batch card shows. `needBytes` and `freeBytes` are null when unknown. */
export interface HubBatchView {
  batchId: string
  rows: HubBatchRowView[]
  needBytes: number | null
  freeBytes: number | null
  /** The parent works in the main checkout: merging children there changes its branch. */
  mainCheckout: boolean
}

export const HUB_MAIN_CHECKOUT_WARNING =
  'This chat works in the main checkout. Merging children here changes its branch.'

const GIB = 1024 ** 3

export const formatGiB = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`

/** Why the disk cannot take the batch, or null: free space after it must stay at or above the floor. */
export function hubDiskProblem(d: { freeBytes: number; needBytes: number; minFreeGiB: number }): string | null {
  if (d.freeBytes - d.needBytes >= d.minFreeGiB * GIB) return null
  return `Not enough disk: the children need about ${formatGiB(d.needBytes)} and ${formatGiB(d.freeBytes)} is free, which would leave less than ${d.minFreeGiB} GiB.`
}

/** The card as plain text, for clients that do not draw it. */
export function hubBatchDetail(view: HubBatchView): string {
  const rows = view.rows.map(
    (r, i) =>
      `${i + 1}. ${r.title} - ${r.agent}${r.model ? ` ${r.model}` : ''}, ${r.mode}, ` +
      (r.location === 'project' ? 'in the project folder' : `worktree off ${r.baseRef}, deps: ${r.deps}`),
  )
  const lines = [`Start ${view.rows.length} child chat${view.rows.length === 1 ? '' : 's'}:`, ...rows]
  if (view.needBytes !== null && view.freeBytes !== null)
    lines.push(`Disk: needs about ${formatGiB(view.needBytes)}, ${formatGiB(view.freeBytes)} free.`)
  if (view.mainCheckout) lines.push(HUB_MAIN_CHECKOUT_WARNING)
  return lines.join('\n')
}

// ─── Views for clients ──────────────────────────────────────────

/** A chat the hub UI can open the sidebar way: root id, every id of its thread, title, agent, project. */
export type HubChatRef = Omit<PrLinkChat, 'linkSource'>

/** One child as the strip and the sidebar show it. */
export interface HubChildView {
  chat: HubChatRef
  /** The id its session runs under now, or null when it is not running. Stop goes there. */
  liveId: string | null
  phase: HubChildPhase
  state: ChildState
  /** Working, but it already reported: its native subagents still run. */
  reported?: true
  limit: LimitState['kind']
  waitingForSlot: boolean
  account: string | null
  branch: string | null
  lastWake: { kind: HubWakeKind; summary: string } | null
  /** Context tokens and known cost (USD, only where the provider reports it) of its last turn. */
  lastTurn: { usedTokens: number | null; costUsd: number | null } | null
}

/** What a chat shows about the hub: its parent while it is an open child, its unsettled children while it has any. */
export interface HubChatView {
  /** The chat itself; null in the empty view. */
  self: HubChatRef | null
  parent: HubChatRef | null
  children: HubChildView[]
  state: ParentState | null
  /** Updates held for Deliver (a Stop, failed deliveries, the hourly cap); absent when none. */
  heldUpdates?: number
}

export const EMPTY_HUB_VIEW: HubChatView = { self: null, parent: null, children: [], state: null }

/** The optional `hub` field of a session list row (flag on only): on an open child, or on a parent with open children. */
export type SessionHubField = { parentId: string } | { openChildren: number }

/** Session list rows with their `hub` field, from every open child as `{ childId, parentId }`. Pure. */
export function withHubFields<T extends { id: string; hub?: SessionHubField }>(
  sessions: readonly T[],
  openChildren: ReadonlyArray<{ childId: string; parentId: string }>,
): T[] {
  if (openChildren.length === 0) return [...sessions]
  const parentOf = new Map(openChildren.map((c) => [c.childId, c.parentId]))
  const counts = new Map<string, number>()
  for (const c of openChildren) counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1)
  return sessions.map((s) => {
    const parentId = parentOf.get(s.id)
    if (parentId) return { ...s, hub: { parentId } }
    const n = counts.get(s.id)
    return n ? { ...s, hub: { openChildren: n } } : s
  })
}

/**
 * Sidebar order with each open child under its parent, in the list's own
 * order. A child whose parent is not in the list (archived, another project)
 * stays at the top level.
 */
export function nestHubChildren<T extends { id: string; hub?: SessionHubField }>(
  sessions: readonly T[],
): Array<{ session: T; children: T[] }> {
  const ids = new Set(sessions.map((s) => s.id))
  const parentOf = (s: T) => (s.hub && 'parentId' in s.hub && ids.has(s.hub.parentId) ? s.hub.parentId : null)
  const children = new Map<string, T[]>()
  for (const s of sessions) {
    const p = parentOf(s)
    if (p) children.set(p, [...(children.get(p) ?? []), s])
  }
  return sessions.filter((s) => !parentOf(s)).map((session) => ({ session, children: children.get(session.id) ?? [] }))
}

export const CHILD_STATE_LABELS: Record<ChildState, string> = {
  settled: 'Settled',
  starting: 'Starting',
  needs_you: 'Needs you',
  working: 'Working',
  limited: 'Limited',
  asked_hub: 'Asked the hub',
  result_ready: 'Result ready',
  blocked: 'Blocked',
  failed: 'Failed',
  paused: 'Paused',
}

export function childStateLabel(c: Pick<HubChildView, 'state' | 'reported' | 'waitingForSlot'>): string {
  if (c.reported) return 'Reported, subagents still running'
  if (c.state === 'starting' && c.waitingForSlot) return 'Waiting for a slot'
  return CHILD_STATE_LABELS[c.state]
}

const PARENT_STATE_LABELS: Record<ParentState, string | null> = {
  working: 'Working',
  limited: 'Limited',
  updates_ready: 'Updates ready',
  waiting: 'Waiting for children',
  done: 'Done',
  idle: null,
}

export const parentStateLabel = (state: ParentState | null): string | null =>
  state ? PARENT_STATE_LABELS[state] : null

/** "1 child", "3 children". */
export const hubChildCount = (n: number): string => `${n} ${n === 1 ? 'child' : 'children'}`

/** The header chip as one line of text: "Hub, 3 children" and the parent state when it has one. */
export function hubChipText(view: Pick<HubChatView, 'children' | 'state'>): string {
  const label = parentStateLabel(view.state)
  return `Hub, ${hubChildCount(view.children.length)}${label ? ` · ${label}` : ''}`
}

/** What a Nudge chip puts in the parent's message: who it is for and how to pass it on. */
export function hubNudgeContent(child: HubChatRef): string {
  return (
    `The user's next words are for the child chat "${child.title}" (childId: ${child.id}). ` +
    'Pass them on with send_agent_message, in your own words where that helps.'
  )
}
