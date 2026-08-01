/**
 * Sending to the Expo push service.
 *
 * The backend sends, not the phone: the phone is asleep when it matters. Wire
 * shaping and response reading are pure functions so they can be tested without
 * a network; `sendPush` is the only part that does IO.
 */
import { ANDROID_CHANNEL_ID, type PushMessage } from '@shared/push-policy'
import { createMainLogger } from '../logger'

const log = createMainLogger('push:expo')

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** Expo rejects oversized batches; it documents 100 messages per request. */
export const MAX_BATCH = 100

export { ANDROID_CHANNEL_ID }

export interface ExpoPushRequest {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound: 'default'
  priority: 'high'
  channelId: string
}

export function buildRequests(tokens: string[], message: PushMessage): ExpoPushRequest[] {
  return tokens.map((to) => ({
    to,
    title: message.title,
    body: message.body,
    data: message.data,
    sound: 'default',
    priority: 'high',
    channelId: ANDROID_CHANNEL_ID,
  }))
}

export function chunk<T>(items: T[], size = MAX_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getPushReceipts'

/** Expo documents 1000 receipt ids per request. */
export const MAX_RECEIPT_BATCH = 1_000

interface ExpoTicket {
  status?: string
  message?: string
  id?: string
  details?: { error?: string }
}

/**
 * A ticket id to look up later. A ticket only says Expo accepted the message;
 * whether the device took it lands on the receipt minutes later, and that is
 * where `DeviceNotRegistered` usually arrives. Reading only tickets means dead
 * tokens are almost never pruned.
 */
export interface PendingReceipt {
  id: string
  token: string
}

/** Ticket ids worth following up, i.e. the accepted ones. Tickets are positional. */
export function pendingReceiptsFrom(tokens: string[], body: unknown): PendingReceipt[] {
  const data = (body as { data?: ExpoTicket[] } | null)?.data
  if (!Array.isArray(data)) return []
  const pending: PendingReceipt[] = []
  data.forEach((ticket, i) => {
    const token = tokens[i]
    if (ticket?.status === 'ok' && typeof ticket.id === 'string' && token) {
      pending.push({ id: ticket.id, token })
    }
  })
  return pending
}

/** An id missing from the response is NOT resolved: Expo returns nothing for a
 *  receipt that is not ready, and dropping it loses the verdict. */
export function readReceipts(
  pending: readonly PendingReceipt[],
  body: unknown,
): { deadTokens: string[]; resolvedIds: string[] } {
  const data = (body as { data?: Record<string, ExpoTicket> } | null)?.data
  if (!data || typeof data !== 'object') return { deadTokens: [], resolvedIds: [] }
  const deadTokens: string[] = []
  const resolvedIds: string[] = []
  for (const entry of pending) {
    const receipt = data[entry.id]
    if (!receipt) continue
    resolvedIds.push(entry.id)
    if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
      deadTokens.push(entry.token)
    }
  }
  return { deadTokens, resolvedIds }
}

/** Best effort like `sendPush`: an unresolved id stays pending. */
export async function fetchReceipts(
  pending: readonly PendingReceipt[],
): Promise<{ deadTokens: string[]; resolvedIds: string[] }> {
  const deadTokens: string[] = []
  const resolvedIds: string[] = []
  for (const batch of chunk([...pending], MAX_RECEIPT_BATCH)) {
    try {
      const res = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ids: batch.map((entry) => entry.id) }),
      })
      if (!res.ok) {
        log.warn(`receipt lookup rejected: ${res.status} ${res.statusText}`)
        continue
      }
      const result = readReceipts(batch, await res.json())
      deadTokens.push(...result.deadTokens)
      resolvedIds.push(...result.resolvedIds)
    } catch (err) {
      log.warn('receipt lookup failed', err)
    }
  }
  return { deadTokens, resolvedIds }
}

/**
 * Tokens the service says are dead, so the caller can forget them.
 *
 * `DeviceNotRegistered` means the app was uninstalled or the token rotated.
 * Expo asks senders to stop using such a token; continuing to send is how an
 * account gets rate-limited. Tickets come back positionally.
 */
export function deadTokensFrom(tokens: string[], body: unknown): string[] {
  const data = (body as { data?: ExpoTicket[] } | null)?.data
  if (!Array.isArray(data)) return []
  const dead: string[] = []
  data.forEach((ticket, i) => {
    if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' && tokens[i]) {
      dead.push(tokens[i])
    }
  })
  return dead
}

export interface SendResult {
  sent: number
  deadTokens: string[]
  /** Ticket ids to look up once Expo has had time to attempt delivery. */
  pendingReceipts: PendingReceipt[]
}

/**
 * Best effort by design. A notification that fails to send must never break the
 * turn that triggered it, so every failure is logged and swallowed.
 */
export async function sendPush(tokens: string[], message: PushMessage): Promise<SendResult> {
  if (tokens.length === 0) return { sent: 0, deadTokens: [], pendingReceipts: [] }
  let sent = 0
  const deadTokens: string[] = []
  const pendingReceipts: PendingReceipt[] = []

  for (const batch of chunk(tokens)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildRequests(batch, message)),
      })
      if (!res.ok) {
        log.warn(`push rejected: ${res.status} ${res.statusText}`)
        continue
      }
      const body: unknown = await res.json()
      deadTokens.push(...deadTokensFrom(batch, body))
      pendingReceipts.push(...pendingReceiptsFrom(batch, body))
      sent += batch.length
    } catch (err) {
      log.warn('push send failed', err)
    }
  }
  return { sent, deadTokens, pendingReceipts }
}
