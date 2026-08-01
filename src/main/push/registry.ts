/**
 * Push token registry and the event subscription that sends notifications.
 *
 * Tokens live in the backend settings table, so a phone stays registered with
 * a given backend across restarts of both. The decision of what to send is in
 * shared/push-policy; this wires it to the event bus and the sender.
 */
import { isExpoPushToken, pushForEvent, pushTargets, type PushKind } from '@shared/push-policy'
import type { RuntimeEvent } from '@shared/provider-events'
import { getSetting, setSetting, getConversationById } from '../db/database'
import type { RuntimeEventBus } from '../provider/event-bus'
import { createMainLogger } from '../logger'
import { sendPush } from './expo-push'

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
 * Threads each client currently has open, reported by the client itself - only
 * it knows what is on screen. Keyed by viewer ref: a phone uses its push token,
 * the desktop uses DESKTOP_VIEWER_REF because it has no token to key on.
 */
const viewing = new Map<string, string>()

export function setViewing(ref: string, threadId: string | null): void {
  if (threadId === null) viewing.delete(ref)
  else viewing.set(ref, threadId)
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

/**
 * Subscribe to the event bus and notify registered devices. Returns an
 * unsubscribe function.
 */
export function attachPushNotifier(bus: RuntimeEventBus): () => void {
  const onEvent = (event: RuntimeEvent): void => {
    if (!pushEnabled()) return
    const devices = listDevices()
    if (devices.length === 0) return

    const targets = pushTargets(devices, event.threadId, viewing)
    if (targets.length === 0) return

    const { title, projectPath } = conversationFor(event.threadId)
    const message = pushForEvent(event, { title })
    if (!message) return

    for (const [clientRef, tokens] of groupByClientRef(targets)) {
      void sendPush(tokens, {
        ...message,
        data: { ...message.data, projectPath, clientRef, title },
      }).then(({ deadTokens }) => {
        // Expo asks senders to stop using a DeviceNotRegistered token.
        if (deadTokens.length > 0) {
          saveDevices(listDevices().filter((d) => !deadTokens.includes(d.token)))
          log.info(`dropped ${deadTokens.length} unregistered device(s)`)
        }
      })
    }
  }

  return bus.subscribe(onEvent)
}

export type { PushKind }
