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
  type ViewingLease,
} from '@shared/push-policy'
import type { RuntimeEvent } from '@shared/provider-events'
import { getSetting, setSetting, getConversationById } from '../db/database'
import type { RuntimeEventBus } from '../provider/event-bus'
import { createMainLogger } from '../logger'
import { fetchReceipts, sendPush, type PendingReceipt } from './expo-push'

const log = createMainLogger('push:registry')

const SETTING_KEY = 'pushTokens'
const ENABLED_KEY = 'pushEnabled'

export interface PushDevice {
  token: string
  /** Free-text, so a user with two phones can tell them apart. */
  label?: string
  /** The client's own id for this backend, echoed back in every payload. */
  clientRef?: string
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
): { ok: boolean; error?: string } {
  if (!isExpoPushToken(token)) return { ok: false, error: 'not an Expo push token' }
  saveDevices(upsertDevice(listDevices(), { token, label, clientRef, registeredAt: Date.now() }))
  log.info(`registered push device${label ? ` (${label})` : ''}`)
  return { ok: true }
}

export function unregisterDevice(token: string): void {
  const next = listDevices().filter((d) => d.token !== token)
  saveDevices(next)
  log.info('unregistered push device')
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
export function attachPushNotifier(bus: RuntimeEventBus): () => void {
  const onEvent = (event: RuntimeEvent): void => {
    if (!pushEnabled()) return
    const devices = listDevices()
    if (devices.length === 0) return

    const now = Date.now()
    pruneViewing(now)
    const targets = pushTargets(devices, event.threadId, viewing, now)
    if (targets.length === 0) return

    // Decide FIRST: `conversationFor` is a synchronous SQLite read, and delta
    // streaming made this run once per token on the main process.
    if (!pushForEvent(event)) return
    const { title, projectPath } = conversationFor(event.threadId)
    const message = pushForEvent(event, { title })
    if (!message) return

    for (const [clientRef, tokens] of groupByClientRef(targets)) {
      void sendPush(tokens, {
        ...message,
        data: { ...message.data, projectPath, clientRef, title },
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

  const unsubscribe = bus.subscribe(onEvent)
  const sweep = setInterval(() => void sweepReceipts(), RECEIPT_SWEEP_MS)
  sweep.unref?.()
  return () => {
    clearInterval(sweep)
    unsubscribe()
  }
}

export type { PushKind }
