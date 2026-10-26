import type { ChatMessage } from '@shared/types'
import { DESKTOP_HISTORY_WINDOW } from './history-window'

/**
 * How much history one chat may hold in the renderer. Past either limit the
 * oldest turns leave the store and load again through the older-window path.
 */
export interface HistoryMemoryBudget {
  maxMessages: number
  maxBytes: number
  /** A trim keeps this share of each limit, so the next few appends do not trim again. */
  targetShare: number
  /** A trim never keeps fewer rows than this, whatever their size. */
  minKept: number
}

export const HISTORY_MEMORY_BUDGET: HistoryMemoryBudget = {
  maxMessages: 1500,
  maxBytes: 16 * 1024 * 1024,
  targetShare: 0.75,
  minKept: 2 * DESKTOP_HISTORY_WINDOW,
}

/** Fixed cost of a row (object, id, role, timestamp), in bytes. */
const ROW_OVERHEAD_BYTES = 200

/** A JS string holds up to two bytes per character. */
function textBytes(text: string | undefined): number {
  return text ? text.length * 2 : 0
}

/** Estimated renderer memory of one row: its text, tool calls, image data URLs and cards. */
export function estimateMessageBytes(message: ChatMessage): number {
  let bytes = ROW_OVERHEAD_BYTES + textBytes(message.content) + textBytes(message.displayBody)
  for (const call of message.toolCalls ?? []) {
    bytes += textBytes(call.name) + textBytes(call.input) + textBytes(call.output)
  }
  for (const image of message.images ?? []) bytes += textBytes(image.url)
  if (message.plan) bytes += textBytes(message.plan.markdown)
  if (message.fileDiff) bytes += textBytes(message.fileDiff.oldContent) + textBytes(message.fileDiff.newContent)
  if (message.approval) bytes += textBytes(message.approval.detail)
  for (const item of message.todos?.items ?? []) bytes += textBytes(item.text)
  for (const question of message.question?.questions ?? []) bytes += textBytes(question.question)
  return bytes
}

/** A row that still waits on the user or the backend: a pending card or an unechoed send. */
function isLive(message: ChatMessage): boolean {
  return (
    message.deliveryState === 'pending' ||
    message.approval?.status === 'pending' ||
    message.question?.status === 'pending' ||
    message.fileDiff?.status === 'pending'
  )
}

/**
 * How many of the oldest rows to drop so the chat fits its budget, or 0.
 *
 * The cut lands on a user row, so whole turns go and the new first row is a
 * row the backend paged out (a valid older-window cursor). It never reaches
 * `protectFrom` (the first row shown in any view), the last turn (the
 * streaming tail), a live row, or the last `minKept` rows.
 */
export function planHistoryTrim(
  messages: readonly ChatMessage[],
  protectFrom: number = messages.length,
  budget: HistoryMemoryBudget = HISTORY_MEMORY_BUDGET,
): number {
  const sizes = messages.map(estimateMessageBytes)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (messages.length <= budget.maxMessages && total <= budget.maxBytes) return 0

  let limit = Math.min(protectFrom, messages.length - budget.minKept)
  const firstLive = messages.findIndex(isLive)
  if (firstLive >= 0) limit = Math.min(limit, firstLive)
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  limit = Math.min(limit, Math.max(lastUser, 0))

  const keepMessages = budget.maxMessages * budget.targetShare
  const keepBytes = budget.maxBytes * budget.targetShare
  let dropped = 0
  let droppedBytes = 0
  let cut = 0
  for (let i = 1; i <= limit; i++) {
    dropped++
    droppedBytes += sizes[i - 1]
    if (messages[i].role !== 'user' || messages[i].parentToolCallId) continue
    cut = i
    if (messages.length - dropped <= keepMessages && total - droppedBytes <= keepBytes) break
  }
  return cut
}
