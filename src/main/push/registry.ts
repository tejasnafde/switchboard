/**
 * Push token registry and the event subscription that sends notifications.
 *
 * Tokens live in the backend settings table, so a phone stays registered with
 * a given backend across restarts of both. The decision of what to send is in
 * shared/push-policy; this wires it to the event bus and the sender.
 */
import {
  isExpoPushToken,
  isLeaseLive,
  pushForEvent,
  pushTargets,
  type PushKind,
  type PushMessage,
  type ViewingLease,
} from '@shared/push-policy'
import type { RuntimeEvent } from '@shared/provider-events'
import { getSetting, setSetting, getConversationById } from '../db/database'
import type { RuntimeEventBus } from '../provider/event-bus'
import { createMainLogger } from '../logger'
import { isUserPresent, type PresenceProbe } from '@shared/push-presence'
import { fetchReceipts, sendPush, type PendingReceipt } from './expo-push'

const log = createMainLogger('push:registry')

const SETTING_KEY = 'pushTokens'
const ENABLED_KEY = 'pushEnabled'
/** Suppress push while the user is demonstrably at this machine. Default on. */
const WHILE_ACTIVE_KEY = 'pushWhileActive'

export function pushWhileActive(): boolean {
  return getSetting(WHILE_ACTIVE_KEY) === 'true'
}

export interface PushDevice {
  token: string
  /** Free-text, so a user with two phones can tell them apart. */
  label?: string
  /** The client's own id for this backend, echoed back in every payload. */
  clientRef?: string
  deviceSessionId?: string
  registeredAt: number
}

/** Parse the stored list, tolerating an absent or corrupt row. */
export function parseDevices(raw: string | null): PushDevice[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (d): d is PushDevice => typeof d === 'object' && d !== null && isExpoPushToken((d as PushDevice).token),
    )
  } catch {
    return []
  }
}

/** Add or refresh a device, keyed by token so re-registering is idempotent. */
export function upsertDevice(devices: PushDevice[], device: PushDevice): PushDevice[] {
  const others = devices.filter((d) => d.token !== device.token)
  return [...others, device]
}

export function listDevices(): PushDevice[] {
  return parseDevices(getSetting(SETTING_KEY))
}

function saveDevices(devices: PushDevice[]): void {
  setSetting(SETTING_KEY, JSON.stringify(devices))
}

export function registerDevice(
  token: string,
  label?: string,
  clientRef?: string,
  deviceSessionId?: string,
): { ok: boolean; error?: string } {
  if (!isExpoPushToken(token)) return { ok: false, error: 'not an Expo push token' }
  saveDevices(upsertDevice(listDevices(), { token, label, clientRef, deviceSessionId, registeredAt: Date.now() }))
  log.info(`registered push device${label ? ` (${label})` : ''}`)
  return { ok: true }
}

export function unregisterDevice(token: string): void {
  viewing.delete(token)
  const next = listDevices().filter((d) => d.token !== token)
  saveDevices(next)
  log.info('unregistered push device')
}

/**
 * Drops the revoked session's push tokens, and every token with no owner: a
 * token registered before ownership tracking may belong to the revoked phone,
 * and would keep notifying it. A live phone re-registers on its next connect.
 */
export function unregisterSessionDevices(deviceSessionId: string): void {
  const devices = listDevices()
  const removed = devices.filter((d) => d.deviceSessionId === deviceSessionId || !d.deviceSessionId)
  if (removed.length === 0) return
  saveDevices(devices.filter((d) => !removed.includes(d)))
  for (const device of removed) viewing.delete(device.token)
  log.info('removed revoked session push tokens', { count: removed.length })
}

export function pushEnabled(): boolean {
  return getSetting(ENABLED_KEY) !== 'false'
}

/**
 * Threads each client has open, reported by the client - only it knows what is
 * on screen. Keyed by viewer ref: a phone uses its push token, the desktop uses
 * DESKTOP_VIEWER_REF. Leases with an expiry, because a client that dies without
 * saying goodbye is the common case on a phone.
 */
const viewing = new Map<string, ViewingLease>()

export function setViewing(ref: string, threadId: string | null, nowMs: number = Date.now()): void {
  if (threadId === null) viewing.delete(ref)
  else viewing.set(ref, { threadId, atMs: nowMs })
}

/** Drop expired leases so the map cannot grow without bound across sessions. */
function pruneViewing(nowMs: number): void {
  for (const [ref, lease] of viewing) {
    if (!isLeaseLive(lease, nowMs)) viewing.delete(ref)
  }
}

function conversationFor(threadId: string): { title?: string; projectPath?: string } {
  try {
    const row = getConversationById(threadId)
    return { title: row?.title, projectPath: row?.project_path }
  } catch (err) {
    log.warn('conversation lookup failed for push', err)
    return {}
  }
}

/**
 * Devices grouped by the client id they registered with, because that value is
 * echoed into each payload and therefore differs per group.
 */
export function groupByClientRef(devices: PushDevice[]): Map<string | undefined, string[]> {
  const groups = new Map<string | undefined, string[]>()
  for (const d of devices) {
    const list = groups.get(d.clientRef) ?? []
    list.push(d.token)
    groups.set(d.clientRef, list)
  }
  return groups
}

/** In memory on purpose: a receipt is only a token-cleanup hint, so losing the
 *  queue on restart costs one more failed send. */
const pending: Array<PendingReceipt & { queuedAt: number }> = []

/** Expo discards receipts after about a day, so an id unresolved by then never
 *  will be, and re-queueing it forever grows every subsequent request. */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000

/** A receipt does not exist until delivery has been attempted; 15 minutes is
 *  Expo's own suggested wait. */
export const RECEIPT_SWEEP_MS = 15 * 60_000

function dropDeadTokens(deadTokens: string[]): void {
  if (deadTokens.length === 0) return
  // Expo asks senders to stop using a DeviceNotRegistered token; continuing is
  // how an account gets rate-limited.
  saveDevices(listDevices().filter((d) => !deadTokens.includes(d.token)))
  log.info(`dropped ${deadTokens.length} unregistered device(s)`)
}

/** Resolve queued tickets, prune condemned tokens, and keep the rest queued. */
async function sweepReceipts(): Promise<void> {
  if (pending.length === 0) return
  const batch = pending.splice(0, pending.length)
  const { deadTokens, resolvedIds } = await fetchReceipts(batch)
  dropDeadTokens(deadTokens)
  // An id Expo had no answer for yet goes back in the queue rather than being
  // dropped, or its verdict would be lost for good.
  const resolved = new Set(resolvedIds)
  const cutoff = Date.now() - RECEIPT_MAX_AGE_MS
  const expired = batch.filter((entry) => !resolved.has(entry.id) && entry.queuedAt <= cutoff)
  if (expired.length > 0) log.info(`gave up on ${expired.length} receipt(s) Expo never resolved`)
  pending.push(...batch.filter((entry) => !resolved.has(entry.id) && entry.queuedAt > cutoff))
}

/**
 * Subscribe to the event bus and notify registered devices. Returns an
 * unsubscribe function.
 */
/** The live notifier's send, for a push that is not a runtime event (a snooze wake). */
let deliverToThread: ((threadId: string, message: PushMessage) => void) | null = null

/** One push about a chat, under the same policy as event pushes. No-op before `attachPushNotifier`. */
export function pushToThread(threadId: string, message: PushMessage): void {
  deliverToThread?.(threadId, message)
}

export function attachPushNotifier(bus: RuntimeEventBus, presence: PresenceProbe | null = null): () => void {
  /** Devices to tell about this thread now, or none (push off, the user at the machine, the thread on screen). */
  const targetsFor = (threadId: string): PushDevice[] => {
    if (!pushEnabled()) return []
    // At the machine, so the phone in your pocket has nothing to tell you that
    // the screen in front of you is not already showing. Covers every thread,
    // not just the focused one, and does not care which window has focus.
    if (!pushWhileActive() && isUserPresent(presence)) return []
    const devices = listDevices()
    if (devices.length === 0) return []
    const now = Date.now()
    pruneViewing(now)
    return pushTargets(devices, threadId, viewing, now)
  }
  const deliver = (
    targets: PushDevice[],
    message: PushMessage,
    conversation: { title?: string; projectPath?: string },
  ) => {
    for (const [clientRef, tokens] of groupByClientRef(targets)) {
      void sendPush(tokens, {
        ...message,
        data: { ...message.data, projectPath: conversation.projectPath, clientRef, title: conversation.title },
      }).then(({ deadTokens, pendingReceipts }) => {
        dropDeadTokens(deadTokens)
        // The ticket only says Expo accepted the message. The delivery verdict
        // arrives on the receipt minutes later, which is where
        // DeviceNotRegistered usually shows up.
        const queuedAt = Date.now()
        pending.push(...pendingReceipts.map((entry) => ({ ...entry, queuedAt })))
      })
    }
  }
  deliverToThread = (threadId, message) => {
    const targets = targetsFor(threadId)
    if (targets.length > 0) deliver(targets, message, conversationFor(threadId))
  }
  const onEvent = (event: RuntimeEvent): void => {
    const targets = targetsFor(event.threadId)
    if (targets.length === 0) return
    // Decide FIRST: `conversationFor` is a synchronous SQLite read, and delta
    // streaming made this run once per token on the main process.
    if (!pushForEvent(event)) return
    const conversation = conversationFor(event.threadId)
    const message = pushForEvent(event, { title: conversation.title })
    if (message) deliver(targets, message, conversation)
  }

  const unsubscribe = bus.subscribe(onEvent)
  const sweep = setInterval(() => void sweepReceipts(), RECEIPT_SWEEP_MS)
  sweep.unref?.()
  return () => {
    clearInterval(sweep)
    unsubscribe()
    deliverToThread = null
  }
}

export type { PushKind }
