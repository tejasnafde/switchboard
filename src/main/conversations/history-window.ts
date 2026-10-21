import type { ChatMessage } from '@shared/types'
import { historyWindowLimit } from '@shared/phone-history-window'
import { dedupeMessagesById, LEGACY_ID_MATCH_WINDOW_MS, mergeConversationMessages } from '../agent/dedupe-messages'

/**
 * The stored rows a window needs, read by index range instead of in full.
 * Rows come back oldest first, in the order the full read returns them.
 */
export interface WindowRows {
  /** Timestamps of the newest `count` rows at or before `atOrBefore`, newest first. */
  newestTimestamps(atOrBefore: number, count: number): number[]
  /** User row timestamps at or before `at`, newest first, at most `count`. */
  userTimestampsBefore(at: number, count: number): number[]
  /** User row timestamps after `at`, oldest first, at most `count`. */
  userTimestampsAfter(at: number, count: number): number[]
  /** Rows from `from` to `to` plus rows with one of `ids`, in the full read's order. */
  read(from: number, to: number, ids: readonly string[]): ChatMessage[]
  timestampOf(id: string): number | undefined
  hasRowBefore(at: number): boolean
  count(): number
}

export interface MergedWindow {
  messages: ChatMessage[]
  /** An estimate for windowed reads: the larger of the transcript and stored counts. */
  total: number
  truncated: boolean
  nextBeforeId: string | null
  cursorReset: boolean
  /** Rows read from SQLite for this window. */
  rowsRead: number
}

export interface MergeWindowRequest {
  limit?: number
  /** Rows strictly older than this message (the next older page). */
  beforeId?: string
  /** Rows up to and including this message (one message, for a lookup). */
  throughId?: string
}

// Two copies of one user message open one turn when this close (dedupe-messages).
const USER_COPY_SKEW_MS = 5_000
const TURN_PROBE = 16

/**
 * The window `historyWindow(mergeConversationMessages(disk, rows))` would cut,
 * merged from only the rows near it. An assistant row matches only inside its
 * own turn and a user row within a minute, so the merge reads from one whole
 * turn before the window's oldest row to one turn after its newest, plus the
 * rows sharing an id with a transcript message in that range.
 * ponytail: a stored tool output or task notice more than a turn away from its
 * transcript line is not paired, and the row shows on its own; read in full if seen.
 */
export function mergeHistoryWindow(
  diskMessages: ChatMessage[],
  rows: WindowRows,
  request: MergeWindowRequest,
): MergedWindow {
  const limit = request.throughId ? 1 : historyWindowLimit(request.limit)
  const disk = dedupeMessagesById(diskMessages).messages
  const diskById = new Map(disk.map((message) => [message.id, message]))
  const cursorId = request.throughId ?? request.beforeId
  const cursorAt = cursorId ? (diskById.get(cursorId)?.timestamp ?? rows.timestampOf(cursorId)) : undefined
  if (cursorId && cursorAt === undefined) {
    if (request.throughId) return emptyWindow(disk, rows)
    return { ...mergeHistoryWindow(diskMessages, rows, { limit }), cursorReset: true }
  }
  const upper = cursorAt ?? Infinity

  // Ties at the cursor's timestamp count only up to the cursor in transcript order.
  const cursorIndex = cursorId ? disk.findIndex((message) => message.id === cursorId) : -1
  const diskAtOrBefore = disk
    .filter(
      (message, index) =>
        message.timestamp < upper || (message.timestamp === upper && (cursorIndex < 0 || index <= cursorIndex)),
    )
    .map((message) => message.timestamp)
    .sort((a, b) => b - a)
  // The cursor row itself is among the rows at its timestamp.
  const need = request.beforeId ? limit + 1 : limit
  // Transcript lines always survive the merge, so `need` of them bound the
  // window. A stored row can fold into an older line, so stored rows bound it
  // only when the transcript is shorter.
  const oldest =
    diskAtOrBefore.length >= need
      ? diskAtOrBefore[need - 1]
      : Math.min(diskAtOrBefore.at(-1) ?? Infinity, rows.newestTimestamps(upper, need)[need - 1] ?? -Infinity)

  const userTimes = (pick: (message: ChatMessage) => boolean) =>
    disk.filter((message) => message.role === 'user' && pick(message)).map((message) => message.timestamp)
  const before = turnStarts(
    [...userTimes((m) => m.timestamp <= oldest), ...rows.userTimestampsBefore(oldest, TURN_PROBE)].sort(
      (a, b) => b - a,
    ),
  )
  // The turn before the window's first, then a minute for user copies.
  const from = (before[1] ?? -Infinity) - LEGACY_ID_MATCH_WINDOW_MS
  const after =
    upper === Infinity
      ? []
      : [...userTimes((m) => m.timestamp > upper), ...rows.userTimestampsAfter(upper, TURN_PROBE)].sort((a, b) => a - b)
  const nextTurn = after.find((at) => at - upper > USER_COPY_SKEW_MS)
  const to = nextTurn === undefined ? Infinity : nextTurn + LEGACY_ID_MATCH_WINDOW_MS

  const nearDisk = disk.filter((message) => message.timestamp >= from && message.timestamp <= to)
  // A row and its transcript copy share an id at any distance: read both sides.
  const stored = rows.read(
    from,
    to,
    nearDisk.map((message) => message.id),
  )
  const nearDiskIds = new Set(nearDisk.map((message) => message.id))
  const missing = stored.filter((row) => diskById.has(row.id) && !nearDiskIds.has(row.id))
  if (missing.length > 0) {
    const diskOrder = new Map(disk.map((message, index) => [message.id, index]))
    nearDisk.push(...missing.map((row) => diskById.get(row.id)!))
    nearDisk.sort((a, b) => diskOrder.get(a.id)! - diskOrder.get(b.id)!)
  }

  const merged = mergeConversationMessages(nearDisk, stored)
  let end = merged.length
  if (cursorId) {
    const at = merged.findIndex((message) => message.id === cursorId)
    if (at < 0) {
      if (request.throughId) return emptyWindow(disk, rows, stored.length)
      return { ...mergeHistoryWindow(diskMessages, rows, { limit }), cursorReset: true }
    }
    end = request.throughId ? at + 1 : at
  }
  let start = end
  while (start > 0 && end - start < limit && merged[start - 1].timestamp >= oldest) start--
  // Never an empty older page while older rows remain: the client would stop paging.
  if (start === end) start = Math.max(0, end - limit)
  const truncated =
    start > 0 || disk.some((message) => message.timestamp < from) || (from > -Infinity && rows.hasRowBefore(from))
  const messages = merged.slice(start, end)
  return {
    messages,
    total: Math.max(disk.length, rows.count()),
    truncated,
    nextBeforeId: truncated && messages.length > 0 ? messages[0].id : null,
    cursorReset: false,
    rowsRead: stored.length,
  }
}

function emptyWindow(disk: ChatMessage[], rows: WindowRows, rowsRead = 0): MergedWindow {
  return {
    messages: [],
    total: Math.max(disk.length, rows.count()),
    truncated: false,
    nextBeforeId: null,
    cursorReset: false,
    rowsRead,
  }
}

/** Starts of the turns the user timestamps open, newest first; close copies open one turn. */
function turnStarts(newestFirst: number[]): number[] {
  const starts: number[] = []
  for (const at of newestFirst) {
    if (starts.length > 0 && starts[starts.length - 1] - at <= USER_COPY_SKEW_MS) starts[starts.length - 1] = at
    else starts.push(at)
  }
  return starts
}

/** A window's wire budget. One larger message still travels alone. */
export const WINDOW_MAX_BYTES = 1024 * 1024

/** Drop the oldest messages of a window past `maxBytes` of JSON; the next older page starts at the first kept one. */
export function capWindowBytes<T extends { messages: ChatMessage[]; truncated: boolean; nextBeforeId?: string | null }>(
  window: T,
  maxBytes = WINDOW_MAX_BYTES,
): T {
  let bytes = 0
  let start = window.messages.length
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(window.messages[start - 1]))
    if (bytes + size > maxBytes && start < window.messages.length) break
    bytes += size
    start--
  }
  if (start === 0) return window
  const messages = window.messages.slice(start)
  return { ...window, messages, truncated: true, nextBeforeId: messages[0].id }
}
