/**
 * The sidebar inbox actions on the desktop: Settle, Snooze, Wake, and the one
 * last Undo they share. Each action patches the lists at once (`onSettledChange`,
 * `onSnoozeChange`), then again from the backend's broadcast, so the row moves
 * before the round trip and every window agrees after it.
 *
 * Undo rules: only the newest action can be undone; any newer inbox action
 * replaces it; it is withdrawn after `INBOX_UNDO_MS`, and a snooze or wake
 * undo also when a broadcast shows the chat at another snooze revision
 * (another device, a wake, a PR event). The undo sends that revision, and the
 * backend refuses it when the chat moved on.
 */
import type { ConversationSettledEvent } from '@shared/chat-settle'
import {
  isWoke,
  pickPreset,
  presetKindOf,
  type ConversationSnoozedEvent,
  type PresetOption,
  type SnoozePresetKind,
  type SnoozeRefusal,
  type SnoozeSurface,
} from '@shared/chat-snooze'
import { useAgentStore, type LastUndo } from '../stores/agent-store'
import { useMachineStore } from '../stores/machine-store'
import { snoozeOf, useSnoozeStore, type ChatSnooze } from '../stores/snooze-store'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:chat-inbox')

type SettledListener = (id: string, settledAt: number | null) => void
type SnoozeListener = (id: string, fields: ChatSnooze) => void

const settledListeners = new Set<SettledListener>()
const snoozeListeners = new Set<SnoozeListener>()

export function onSettledChange(cb: SettledListener): () => void {
  settledListeners.add(cb)
  return () => settledListeners.delete(cb)
}

export function onSnoozeChange(cb: SnoozeListener): () => void {
  snoozeListeners.add(cb)
  return () => snoozeListeners.delete(cb)
}

function emitSettled(id: string, settledAt: number | null): void {
  for (const listener of settledListeners) listener(id, settledAt)
}

function emitSnooze(id: string, fields: ChatSnooze): void {
  if ('wokeAt' in fields) markerClears.delete(id)
  useSnoozeStore.getState().patch(id, fields)
  for (const listener of snoozeListeners) listener(id, fields)
}

const NOT_SNOOZED_FIELDS: ChatSnooze = { snoozedAt: null, snoozedUntil: null, snoozePr: null }
const NO_MARKER: ChatSnooze = { wokeAt: null, wokeReason: null, wokePrSummary: null }

/** How long Undo (the notice and Cmd+Z) is offered after an inbox action. */
export const INBOX_UNDO_MS = 8000
/** How long a refusal stays in the footer. */
export const INBOX_NOTICE_MS = 5000

let undoExpiry: ReturnType<typeof setTimeout> | undefined
let noticeExpiry: ReturnType<typeof setTimeout> | undefined

/** The backend's answer for a snooze or wake undo still in flight. */
const pendingRev = new WeakMap<LastUndo, Promise<number | undefined>>()
/** The newest snooze revision a broadcast or an answer showed, per chat. */
const knownRev = new Map<string, number>()
/** A settle's own clear of a chat's Woke marker, while no later change touched the marker. */
const markerClears = new Map<string, symbol>()

/** Offer one undo, replacing any other, withdrawn after `INBOX_UNDO_MS` whether or not the notice is mounted. */
function offerUndo(undo: LastUndo): void {
  useAgentStore.getState().setLastUndo(undo)
  clearTimeout(undoExpiry)
  undoExpiry = setTimeout(() => dropUndo(undo), INBOX_UNDO_MS)
}

function dropUndo(undo: LastUndo): void {
  if (useAgentStore.getState().lastUndo === undo) useAgentStore.getState().setLastUndo(null)
}

export function showInboxNotice(text: string): void {
  useAgentStore.getState().setInboxNotice(text)
  clearTimeout(noticeExpiry)
  noticeExpiry = setTimeout(() => {
    if (useAgentStore.getState().inboxNotice === text) useAgentStore.getState().setInboxNotice(null)
  }, INBOX_NOTICE_MS)
}

export function refusalText(reason: SnoozeRefusal): string {
  switch (reason) {
    case 'needs_you':
      return 'A chat that needs you cannot be snoozed'
    case 'past':
      return 'That time has passed. Pick another'
    case 'too_far':
      return 'Pick a time within a year'
    case 'pr_closed':
      return 'That pull request is closed'
    case 'pr_unlinked':
      return 'That pull request is not linked to this chat'
    case 'pr_unreadable':
      return 'The pull request could not be read'
    case 'stale':
      return 'The chat changed since. Nothing to undo'
    case 'empty':
      return 'Pick a time'
    case 'no_row':
      return 'This chat cannot be snoozed'
  }
}

export interface InboxTarget {
  id: string
  title: string
  machineId: string
}

/** Bind every call, a local one too, so a remote binding left on the same id does not take it. */
function routeTo(target: Pick<InboxTarget, 'id' | 'machineId'>): void {
  window.api.routing.bind(target.id, target.machineId)
}

/** Whether a chat's backend takes Snooze: always here, on a remote only when it announced `chat_snooze_v1`. */
export function machineSupportsSnooze(machineId: string, capability: string): boolean {
  if (machineId === 'local') return true
  return window.api.routing.supportsCapability?.(machineId, capability) === true
}

/** The machine whose sidebar lists the chat, for an event that does not name its source. */
function machineOf(id: string): string {
  const projects = useMachineStore.getState().projects
  for (const [machineId, tree] of Object.entries(projects)) {
    if (tree.some((p) => p.sessions.some((s) => s.id === id))) return machineId
  }
  return 'local'
}

function storedSnooze(id: string): Required<ChatSnooze> {
  return snoozeOf(useSnoozeStore.getState().byId[id] ?? {})
}

/** Put back the state from before a request, unless a broadcast moved the chat to another revision meanwhile. */
function restoreUnlessMoved(id: string, before: Required<ChatSnooze>): void {
  if (storedSnooze(id).snoozeRev !== before.snoozeRev) return
  emitSnooze(id, before)
}

/** Record the revision an action's answer carries; a newer one already seen means the undo is stale. */
function answered(undo: LastUndo, id: string, rev: number | undefined): void {
  if (rev === undefined || undo.kind === 'settle') return
  // Not React state: the notice never shows it, so the store does not re-render for it.
  undo.rev = rev
  const seen = knownRev.get(id)
  if (seen !== undefined && seen > rev) dropUndo(undo)
  else knownRev.set(id, rev)
}

// ---------------------------------------------------------------- settle

/** Settle a Done row. Resolves false when the settle failed and the row came back. */
export async function settleChat(target: InboxTarget): Promise<boolean> {
  const settledAt = Date.now()
  emitSettled(target.id, settledAt)
  const before = storedSnooze(target.id)
  let clear: symbol | undefined
  if (isWoke(before)) {
    emitSnooze(target.id, NO_MARKER)
    clear = Symbol('settle')
    markerClears.set(target.id, clear)
  }
  const undo: LastUndo = { kind: 'settle', ...target, settledAt }
  offerUndo(undo)
  try {
    routeTo(target)
    const result = await window.api.app.settleConversation(target.id)
    if (!result.ok) throw new Error('the chat has no stored row')
    return true
  } catch (err) {
    log.warn(`settle failed for ${target.id}; the row comes back`, err)
    emitSettled(target.id, null)
    if (clear && markerClears.get(target.id) === clear)
      emitSnooze(target.id, {
        wokeAt: before.wokeAt,
        wokeReason: before.wokeReason,
        wokePrSummary: before.wokePrSummary,
      })
    dropUndo(undo)
    return false
  } finally {
    if (clear && markerClears.get(target.id) === clear) markerClears.delete(target.id)
  }
}

function undoSettle(undo: Extract<LastUndo, { kind: 'settle' }>): void {
  emitSettled(undo.id, null)
  routeTo(undo)
  const stillSettled = (err?: unknown) => {
    log.warn(`unsettle failed for ${undo.id}; the chat stays settled`, err)
    emitSettled(undo.id, undo.settledAt)
  }
  const unsettle = () =>
    window.api.app.unsettleConversation(undo.id).then((result) => {
      if (!result.ok) stillSettled()
    }, stillSettled)
  const ended = undo.endedSnooze
  if (!ended) {
    void unsettle()
    return
  }
  // The snooze write also unsettles. A refused one (a PR-only snooze whose PR merged) still unsettles.
  window.api.app.snoozeConversation(undo.id, { until: ended.until, pr: ended.pr, expectRev: ended.rev }).then(
    (result) => {
      if (!result.ok) {
        log.info(`snooze not restored for ${undo.id}`, { reason: result.reason })
        return unsettle()
      }
    },
    (err) => {
      log.warn(`snooze restore failed for ${undo.id}`, err)
      return unsettle()
    },
  )
}

// ---------------------------------------------------------------- snooze and wake

/** A menu preset, the PR wake, or the instant the custom dialog built. */
export type SnoozeChoice = { option: PresetOption } | { pr: string } | { at: number }

/** Whether a snooze would go ahead now, so the row can hand focus on before the answer. */
export function choiceStands(choice: SnoozeChoice, now: number): boolean {
  if ('option' in choice) return pickPreset(choice.option, now).ok
  if ('at' in choice) return choice.at > now
  return true
}

/**
 * Snooze a chat from a menu item or the custom dialog. A clock-time preset
 * keeps the instant the menu showed and is refused, with a notice, once that
 * has passed, as is a custom time; a duration counts from the click. A chat
 * that needs the user is refused here as the backend would.
 */
export async function snoozeChat(
  target: InboxTarget & { needsYou?: boolean },
  choice: SnoozeChoice,
  surface: SnoozeSurface,
  now: number = Date.now(),
): Promise<boolean> {
  if (target.needsYou) {
    showInboxNotice(refusalText('needs_you'))
    return false
  }
  let until: number | null = null
  let pr: string | null = null
  let preset: SnoozePresetKind
  if ('option' in choice) {
    const picked = pickPreset(choice.option, now)
    if (!picked.ok) {
      showInboxNotice(`${choice.option.label} has passed. Pick another time`)
      return false
    }
    until = picked.at
    preset = presetKindOf(choice.option.spec)
  } else if ('at' in choice) {
    if (choice.at <= now) {
      showInboxNotice(refusalText('past'))
      return false
    }
    until = choice.at
    preset = 'custom'
  } else {
    pr = choice.pr
    preset = 'pr'
  }
  const before = storedSnooze(target.id)
  emitSnooze(target.id, { snoozedAt: now, snoozedUntil: until, snoozePr: pr, ...NO_MARKER })
  const undo: LastUndo = { kind: 'snooze', id: target.id, title: target.title, machineId: target.machineId, until, pr }
  offerUndo(undo)
  const answer = (async () => {
    routeTo(target)
    const result = await window.api.app.snoozeConversation(target.id, { until, pr, preset, surface })
    if (!result.ok) {
      log.info(`snooze refused for ${target.id}`, { reason: result.reason })
      restoreUnlessMoved(target.id, before)
      dropUndo(undo)
      showInboxNotice(refusalText(result.reason))
      return undefined
    }
    // A broadcast at a newer revision already holds what the chat is now.
    const seen = knownRev.get(target.id)
    if (seen === undefined || seen <= result.rev)
      emitSnooze(target.id, { snoozedUntil: result.until, snoozePr: result.pr, snoozeRev: result.rev })
    answered(undo, target.id, result.rev)
    return result.rev
  })().catch((err: unknown) => {
    log.warn(`snooze failed for ${target.id}; the row comes back`, err)
    restoreUnlessMoved(target.id, before)
    dropUndo(undo)
    return undefined
  })
  pendingRev.set(undo, answer)
  return (await answer) !== undefined
}

/** End a snooze with no Woke marker (the row's Wake, the composer's Wake now). */
export async function wakeChat(target: InboxTarget, surface: 'row' | 'composer' = 'row'): Promise<boolean> {
  const before = storedSnooze(target.id)
  if (before.snoozedAt == null) return false
  emitSnooze(target.id, { ...NOT_SNOOZED_FIELDS, ...NO_MARKER })
  const undo: LastUndo = {
    kind: 'wake',
    id: target.id,
    title: target.title,
    machineId: target.machineId,
    until: before.snoozedUntil,
    pr: before.snoozePr,
  }
  offerUndo(undo)
  const answer: Promise<{ woke: boolean; rev?: number }> = (async () => {
    routeTo(target)
    const result = await window.api.app.unsnoozeConversation(target.id)
    if (!result.ok) {
      // It had already woken or changed; the broadcast carries what it is now.
      log.info(`wake found ${target.id} not snoozed`, { surface })
      dropUndo(undo)
      return { woke: false }
    }
    // A backend that sends no revision woke the chat, but an Undo could not name the revision to restore.
    if (result.rev === undefined) dropUndo(undo)
    else answered(undo, target.id, result.rev)
    return { woke: true, rev: result.rev }
  })().catch((err: unknown) => {
    log.warn(`wake failed for ${target.id}; the snooze stays`, err)
    restoreUnlessMoved(target.id, before)
    dropUndo(undo)
    return { woke: false }
  })
  pendingRev.set(
    undo,
    answer.then((a) => a.rev),
  )
  return (await answer).woke
}

async function revOf(undo: LastUndo): Promise<number | undefined> {
  if (undo.kind === 'settle') return undefined
  return undo.rev ?? (await pendingRev.get(undo))
}

async function undoSnooze(undo: Extract<LastUndo, { kind: 'snooze' | 'wake' }>): Promise<void> {
  const before = storedSnooze(undo.id)
  emitSnooze(undo.id, NOT_SNOOZED_FIELDS)
  const rev = await revOf(undo)
  if (rev === undefined) {
    emitSnooze(undo.id, before)
    return
  }
  routeTo(undo)
  const result = await window.api.app.unsnoozeConversation(undo.id, rev)
  if (!result.ok) {
    emitSnooze(undo.id, before)
    showInboxNotice(refusalText('stale'))
  }
}

async function undoWake(undo: Extract<LastUndo, { kind: 'snooze' | 'wake' }>, until: number | null): Promise<void> {
  const before = storedSnooze(undo.id)
  emitSnooze(undo.id, { snoozedAt: Date.now(), snoozedUntil: until, snoozePr: undo.pr })
  const rev = await revOf(undo)
  if (rev === undefined) {
    emitSnooze(undo.id, before)
    return
  }
  routeTo(undo)
  const result = await window.api.app.snoozeConversation(undo.id, { until, pr: undo.pr, expectRev: rev })
  if (!result.ok) {
    emitSnooze(undo.id, before)
    showInboxNotice(refusalText(result.reason))
  }
}

/**
 * Reverse `lastUndo`. Returns the restored chat's id (to focus its row), or
 * null when there was nothing to undo. Undo of a Wake does not restore a time
 * that has passed: with a PR wake it keeps only the PR, without one it says so.
 */
export function undoLastInbox(now: number = Date.now()): string | null {
  const undo = useAgentStore.getState().lastUndo
  if (!undo) return null
  useAgentStore.getState().setLastUndo(null)
  if (undo.kind === 'settle') {
    undoSettle(undo)
    return undo.id
  }
  if (undo.kind === 'wake') {
    const passed = undo.until !== null && undo.until <= now
    if (passed && undo.pr === null) {
      showInboxNotice('The snooze time has passed. Nothing to undo')
      return null
    }
    void undoWake(undo, passed ? null : undo.until).catch((err: unknown) =>
      log.warn(`undo of the wake failed for ${undo.id}`, err),
    )
  } else {
    void undoSnooze(undo).catch((err: unknown) => log.warn(`undo of the snooze failed for ${undo.id}`, err))
  }
  void window.api.analytics?.track?.('snooze_undone', { kind: undo.kind })
  return undo.id
}

/** The user opened a chat: drop its Woke marker here and on the backend. */
export function noteChatOpened(id: string, machineId: string = 'local'): void {
  if (!isWoke(storedSnooze(id))) return
  emitSnooze(id, NO_MARKER)
  routeTo({ id, machineId })
  window.api.app.markWokeSeen(id).catch((err: unknown) => log.warn(`marking ${id} seen failed`, err))
}

// ---------------------------------------------------------------- broadcasts

/** A backend broadcast: patch the lists, and offer Undo when a merged PR settled the chat. */
export function applySettledEvent(event: ConversationSettledEvent & { machineId?: string }): void {
  emitSettled(event.conversationId, event.settledAt)
  if (event.settledAt === null || event.prNumber === undefined) return
  offerUndo({
    kind: 'settle',
    id: event.conversationId,
    title: event.title ?? 'Untitled chat',
    machineId: event.machineId ?? machineOf(event.conversationId),
    settledAt: event.settledAt,
    prNumber: event.prNumber,
    endedSnooze: event.endedSnooze,
  })
}

/** A backend snooze broadcast: patch the lists; a snooze or wake undo of that chat at another revision is withdrawn. */
export function applySnoozedEvent(event: ConversationSnoozedEvent & { machineId?: string }): void {
  const { conversationId: id, prSummary, title: _title, machineId: _machine, ...state } = event
  emitSnooze(id, { ...state, wokePrSummary: prSummary ?? null })
  const seen = knownRev.get(id)
  if (seen === undefined || state.snoozeRev > seen) knownRev.set(id, state.snoozeRev)
  const undo = useAgentStore.getState().lastUndo
  if (undo && undo.kind !== 'settle' && undo.id === id && undo.rev !== undefined && undo.rev !== state.snoozeRev)
    dropUndo(undo)
}
