/**
 * Settles a chat whose linked pull request changed to merged. A link change
 * to merged is seen once, so a settle that throws (a busy database, say) is
 * tried again a few times after a delay; each try re-reads the chat and the
 * rule, so a chat that started a turn or was settled meanwhile is left alone.
 */
import { shouldAutoSettle } from '@shared/chat-settle'
import { createMainLogger } from '../logger'

const log = createMainLogger('pr:settle-on-merge')

/** Delays before each retry of a settle that threw. */
export const SETTLE_RETRY_DELAYS_MS = [2_000, 10_000, 60_000] as const

export interface SettleOnMergeDeps {
  /** The chat's root row, or null when it is gone. */
  readChat: (chatId: string) => { id: string; settledAt: number | null } | null
  busy: (threadId: string) => boolean
  needsUser: (threadId: string) => boolean
  /** Stores the settle and tells clients; false when the chat has no row. */
  store: (id: string, settledAt: number, prNumber: number) => boolean
  retryDelaysMs?: readonly number[]
}

export interface SettleOnMerge {
  settle: (chatId: string, prNumber: number) => void
  /** Drops every pending retry (the host or registry went away). */
  cancel: () => void
}

export function createSettleOnMerge(deps: SettleOnMergeDeps): SettleOnMerge {
  const delays = deps.retryDelaysMs ?? SETTLE_RETRY_DELAYS_MS
  const pending = new Map<string, ReturnType<typeof setTimeout>>()

  const attempt = (chatId: string, prNumber: number, tryIndex: number): void => {
    pending.delete(chatId)
    const row = deps.readChat(chatId)
    if (
      !row ||
      !shouldAutoSettle({
        state: 'merged',
        busy: deps.busy(row.id),
        needsUser: deps.needsUser(row.id),
        settledAt: row.settledAt,
      })
    ) {
      if (tryIndex > 0) log.info('a merged pull request no longer settles its chat', { chatId, number: prNumber })
      return
    }
    try {
      if (deps.store(row.id, Date.now(), prNumber)) {
        log.info('settled a chat whose linked pull request merged', { chatId: row.id, number: prNumber, tryIndex })
      }
    } catch (err) {
      const delay = delays[tryIndex]
      log.warn('settling a chat after its pull request merged failed', {
        chatId: row.id,
        number: prNumber,
        tryIndex,
        retryInMs: delay ?? null,
        err: String(err),
      })
      if (delay === undefined) return
      const timer = setTimeout(() => attempt(chatId, prNumber, tryIndex + 1), delay)
      timer.unref?.()
      pending.set(chatId, timer)
    }
  }

  return {
    settle: (chatId, prNumber) => {
      const timer = pending.get(chatId)
      if (timer) clearTimeout(timer)
      attempt(chatId, prNumber, 0)
    },
    cancel: () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    },
  }
}
