/**
 * The footer of a user message the backend holds until the running turn
 * ends: a "Queued" chip, Send now (steer it into the running turn) and
 * Cancel (take it back and put its text in the composer). The row itself
 * disappears on the backend's `turn.dequeued`, on every client.
 *
 * After a failed or usage-limited turn the queue is held: nothing starts
 * until Resume. A message that could not start stays marked "Not sent" until
 * Cancel takes it back.
 */
import { useState } from 'react'
import { promoteUnavailableReason } from '@shared/turn-delivery'
import { Button } from '../ui/button'
import { useAgentStore } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { focusComposer } from '../../services/composer-registry'
import { createRendererLogger } from '../../logger'
import { ArrowUpIcon, ClockIcon, CloseIcon } from './chat-icons'

const log = createRendererLogger('chat:queued-turn')

export function QueuedTurnBar({
  sessionId,
  messageId,
  provider,
}: {
  sessionId: string
  messageId: string
  provider: string | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = useAgentStore((st) => st.sessions.find((s) => s.id === sessionId)?.queuedTurns?.[messageId])
  const failed = entry?.failed
  const held = !failed && entry?.held === true
  const promoteBlocked = promoteUnavailableReason(provider)

  const act = async (action: 'promote' | 'cancel' | 'resume') => {
    setBusy(true)
    setError(null)
    try {
      const api = window.api.provider
      if (action === 'resume') {
        const resumed = await api.resumeQueuedTurns(sessionId)
        if (!resumed.ok) setError(resumed.message ?? 'Nothing is held for this chat.')
        return
      }
      const result =
        action === 'promote'
          ? await api.promoteQueuedTurn(sessionId, messageId)
          : await api.cancelQueuedTurn(sessionId, messageId)
      if (!result.ok) {
        setError(result.message)
        return
      }
      if (action === 'cancel') {
        useDraftStore.getState().appendDraft(sessionId, result.turn.text)
        focusComposer(sessionId)
      }
    } catch (err) {
      log.warn(`${action} of queued message ${messageId} failed`, err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const label = failed ? 'Not sent' : held ? 'Held' : 'Queued'
  const note = failed ?? (held ? 'the last turn failed; Resume sends the queue' : 'runs after this turn')

  return (
    <div
      data-queued-turn={messageId}
      className="mt-[8px] flex items-center gap-[8px] text-[11px] text-[var(--text-muted)]"
    >
      <span className="inline-flex items-center gap-[4px] rounded-[4px] border border-[var(--border)] px-[6px] py-[1px] text-[var(--text-secondary)]">
        <ClockIcon size={11} />
        {label}
      </span>
      <span role="status" aria-live="polite">
        {error ?? note}
      </span>
      <span className="ml-auto inline-flex gap-[2px]">
        {held && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Resume"
            title="Resume: send the held messages in order"
            disabled={busy}
            onClick={() => {
              void act('resume')
            }}
          >
            <ArrowUpIcon size={13} />
          </Button>
        )}
        {!failed && !held && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Send now"
            title={promoteBlocked ?? 'Send now: steer it into the running turn'}
            // aria-disabled, not disabled, so the tooltip saying why still shows.
            aria-disabled={promoteBlocked !== null || undefined}
            disabled={busy}
            onClick={() => {
              if (!promoteBlocked) void act('promote')
            }}
          >
            <ArrowUpIcon size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title="Cancel and return it to the composer"
          disabled={busy}
          onClick={() => {
            void act('cancel')
          }}
        >
          <CloseIcon size={13} />
        </Button>
      </span>
    </div>
  )
}
