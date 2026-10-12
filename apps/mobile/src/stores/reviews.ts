/**
 * The Reviews list per connection: the last list the desktop read, when, and
 * whether the newest read failed. Reads follow `shared/pull-request-refresh.ts`
 * (open, focus at most once a minute, every 5 minutes while shown, manual
 * always), so the phone spends the desktop's host rate limit like its own
 * Reviews view does.
 */
import { create } from 'zustand'
import { createLogger } from '@shared/logger'
import type { PrListData } from '@shared/pull-requests'
import { shouldRefreshPullRequests, type PrRefreshReason } from '@shared/pull-request-refresh'
import { getClient } from './connections'

const log = createLogger('store:reviews')

export interface ReviewsEntry {
  data: PrListData | null
  /** When the last read started. */
  lastFetchAt: number | null
  inFlight: boolean
  /** The newest read failed (transport or host); `data` is the older list, if any. */
  error: string | null
}

const EMPTY: ReviewsEntry = { data: null, lastFetchAt: null, inFlight: false, error: null }

interface ReviewsState {
  byConnection: Record<string, ReviewsEntry>
  refresh(connectionId: string, reason: PrRefreshReason): Promise<void>
}

export function reviewsEntry(state: Pick<ReviewsState, 'byConnection'>, connectionId: string): ReviewsEntry {
  return state.byConnection[connectionId] ?? EMPTY
}

export const useReviewsStore = create<ReviewsState>()((set, get) => {
  const patch = (connectionId: string, next: Partial<ReviewsEntry>) =>
    set((s) => ({ byConnection: { ...s.byConnection, [connectionId]: { ...reviewsEntry(s, connectionId), ...next } } }))

  return {
    byConnection: {},

    async refresh(connectionId, reason) {
      const entry = reviewsEntry(get(), connectionId)
      const now = Date.now()
      if (!shouldRefreshPullRequests({ ...entry, visible: true }, reason, now)) return
      const client = getClient(connectionId)
      if (!client) {
        patch(connectionId, { error: 'Backend not connected yet.' })
        return
      }
      patch(connectionId, { inFlight: true, lastFetchAt: now })
      try {
        const result = await client.listPullRequests()
        if (result.ok) patch(connectionId, { data: result.data, error: null })
        else patch(connectionId, { error: result.error.message })
      } catch (err) {
        log.warn('pull request list failed', err)
        patch(connectionId, { error: err instanceof Error ? err.message : String(err) })
      } finally {
        patch(connectionId, { inFlight: false })
      }
    },
  }
})
