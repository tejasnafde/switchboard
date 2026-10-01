/**
 * A message a session link refused because its budget or time ran out, kept in
 * the sender's chat so the work is not lost while the user is away. Send
 * delivers it as the user's own `/send-to`, which also renews the link.
 */
import { useState } from 'react'
import { peerUndeliveredHeading, type PeerUndelivered } from '@shared/peer-links'
import { useAgentStore } from '../../stores/agent-store'
import { createRendererLogger } from '../../logger'
import { Button } from '../ui/button'

const log = createRendererLogger('chat:peer-undelivered')

export function PeerUndeliveredRow({ row, messageId, sessionId }: {
  row: PeerUndelivered
  messageId: string
  sessionId: string | undefined
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    if (!sessionId) return
    setSending(true)
    setError(null)
    try {
      await window.api.provider.deliverPeerMessage({
        fromThreadId: sessionId,
        fromLabel: useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.title ?? sessionId,
        targetThreadId: row.to,
        text: row.text,
        undeliveredId: messageId,
      })
    } catch (err) {
      log.warn('sending an undelivered peer message failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      data-message-id={messageId}
      data-testid="peer-undelivered-row"
      className="mx-4 my-2 rounded-[8px] border border-dashed border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-[600] text-[var(--text-primary)]">{peerUndeliveredHeading(row)}</span>
        {!row.sent && (
          <Button variant="outline" size="sm" disabled={sending || !sessionId} onClick={() => void send()}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        )}
      </div>
      <div className="mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words">{row.text}</div>
      {error && <div role="alert" className="mt-1 text-[var(--error)]">{error}</div>}
    </div>
  )
}
