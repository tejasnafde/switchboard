/**
 * The footer of a user message the backend holds until the running turn
 * ends: a "Queued" chip, Send now (steer it into the running turn) and
 * Cancel (take it back and put its text in the composer). The row itself
 * disappears on the backend's `turn.dequeued`, on every client.
 */
import { useState } from 'react'
import { promoteUnavailableReason } from '@shared/turn-delivery'
import { Button } from '../ui/button'
import { useDraftStore } from '../../stores/draft-store'
import { focusComposer } from '../../services/composerRegistry'
import { createRendererLogger } from '../../logger'
import { ArrowUpIcon, ClockIcon, CloseIcon } from './chatIcons'

const log = createRendererLogger('chat:queued-turn')

export function QueuedTurnBar({ sessionId, messageId, provider }: {
  sessionId: string
  messageId: string
  provider: string | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const promoteBlocked = promoteUnavailableReason(provider)

  const act = async (action: 'promote' | 'cancel') => {
    setBusy(true)
    setError(null)
    try {
      const api = window.api.provider
      const result = action === 'promote'
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

  return (
    <div
      data-queued-turn={messageId}
      style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}
    >
      <span
        role="status"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '1px 6px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-secondary)',
        }}
      >
        <ClockIcon size={11} />
        Queued
      </span>
      <span>{error ?? 'runs after this turn'}</span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2 }}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Send now"
          title={promoteBlocked ?? 'Send now: steer it into the running turn'}
          // aria-disabled, not disabled, so the tooltip saying why still shows.
          aria-disabled={promoteBlocked !== null || undefined}
          disabled={busy}
          onClick={() => { if (!promoteBlocked) void act('promote') }}
        >
          <ArrowUpIcon size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title="Cancel and return it to the composer"
          disabled={busy}
          onClick={() => { void act('cancel') }}
        >
          <CloseIcon size={13} />
        </Button>
      </span>
    </div>
  )
}
