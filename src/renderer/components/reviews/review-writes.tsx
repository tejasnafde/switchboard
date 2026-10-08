/**
 * Running a pull request write from the Reviews screens: the call, the
 * re-read of what it changed, and the pending and error state a control
 * shows while it waits for the host. Only resolve is optimistic; every other
 * write shows its result once the host has answered.
 */
import { useCallback, useRef, useState } from 'react'
import type { PrWriteDone } from '@shared/pull-request-writes'
import type { PrConversation, PrError, PrRef, PrResult } from '@shared/pull-requests'
import { createRendererLogger } from '../../logger'
import { useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { writeErrorText } from './review-states'

const log = createRendererLogger('reviews:writes')

/** Calls the host; on success (or a stale refusal, which means the screen is behind) re-reads the PR. */
export async function runWrite(
  ref: PrRef,
  action: string,
  call: () => Promise<PrResult<PrWriteDone>>,
): Promise<PrResult<PrWriteDone>> {
  let result: PrResult<PrWriteDone>
  try {
    result = await call()
  } catch (err) {
    log.warn(`${action} failed`, err)
    result = {
      ok: false,
      error: { kind: 'unknown', host: ref.host, message: err instanceof Error ? err.message : String(err) },
    }
  }
  const store = useReviewStore.getState()
  if (result.ok) await store.afterWrite(ref, result.data.refresh)
  else if (result.error.kind === 'stale') await store.afterWrite(ref, ['detail', 'files', 'conversations', 'checks'])
  return result
}

export interface WriteAction {
  pending: boolean
  error: PrError | null
  /** The host's answer, or `null` when a write from this control is already on its way. */
  run: (action: string, call: () => Promise<PrResult<PrWriteDone>>) => Promise<PrResult<PrWriteDone> | null>
  clearError: () => void
}

export function useWriteAction(ref: PrRef): WriteAction {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PrError | null>(null)
  const busy = useRef(false)
  const run = useCallback(
    async (action: string, call: () => Promise<PrResult<PrWriteDone>>) => {
      if (busy.current) return null
      busy.current = true
      setPending(true)
      setError(null)
      const result = await runWrite(ref, action, call)
      busy.current = false
      setPending(false)
      if (!result.ok) setError(result.error)
      return result
      // `ref` is a fresh object per render; host, repo and number name it.
    },
    [ref.host, ref.owner, ref.name, ref.number],
  )
  return { pending, error, run, clearError: () => setError(null) }
}

/** Resolve and unresolve flip the thread at once and flip it back if the host refuses. */
export async function toggleResolved(ref: PrRef, conversation: PrConversation): Promise<PrError | null> {
  const store = useReviewStore.getState()
  const next = !conversation.resolved
  store.setConversationResolved(ref, conversation.id, next)
  const input = { conversationId: conversation.id }
  const result = await runWrite(ref, next ? 'resolve' : 'unresolve', () =>
    next ? window.api.pullRequests.resolve(ref, input) : window.api.pullRequests.unresolve(ref, input),
  )
  if (result.ok) return null
  useReviewStore.getState().setConversationResolved(ref, conversation.id, conversation.resolved)
  return result.error
}

export function WriteError({ error, className }: { error: PrError | null; className?: string }) {
  if (!error) return null
  return (
    <div role="alert" data-review-write-error={error.kind} className={cn('text-[12px] text-[var(--error)]', className)}>
      {writeErrorText(error)}
    </div>
  )
}
