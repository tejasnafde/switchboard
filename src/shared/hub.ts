/**
 * Child chats ("hub"): the pure rules.
 *
 * Any chat can start children. A chat is a child while `hub_children` has an
 * open row for it, and a parent while rows name it as `parent_id`; neither is
 * a chat type. Children report through small wake rows (a summary and a
 * pointer into the child's own transcript), delivered to the parent as one
 * batched turn while it is idle.
 *
 * Nothing reads this module outside tests until the children runner lands.
 */
import type { RuntimeMode } from './provider-events'
import { RUNTIME_MODES } from './provider-events'
import type { LimitState, SettingReader } from './limit-resume'

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

/** A child never gets more access than its parent: the lower of the two modes. */
export function grantedMode(requested: RuntimeMode | undefined, parent: RuntimeMode): RuntimeMode {
  if (!requested) return parent
  return RUNTIME_MODES.indexOf(requested) < RUNTIME_MODES.indexOf(parent) ? requested : parent
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

// ─── Wrappers ───────────────────────────────────────────────────

export const HUB_BRIEF_OPEN = '<switchboard-hub-brief>'
export const HUB_BRIEF_CLOSE = '</switchboard-hub-brief>'
export const HUB_UPDATE_OPEN = '<switchboard-hub-update>'
export const HUB_UPDATE_CLOSE = '</switchboard-hub-update>'

/** `close` cannot appear inside, so agent text cannot end the block early and pass as the user's words. */
const without = (close: string) => (s: string) => s.split(close).join(`${close.slice(0, -1)} >`)
const safeBrief = without(HUB_BRIEF_CLOSE)
const safeUpdate = without(HUB_UPDATE_CLOSE)

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
