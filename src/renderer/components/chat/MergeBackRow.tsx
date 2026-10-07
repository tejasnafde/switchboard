/**
 * A fork's summary in its parent chat (`shared/merge-back.ts`). Pending, it is
 * a card the user can edit or discard before their next message carries it to
 * the agent; delivered, a row that says it went with that message.
 */
import { useState } from 'react'
import { mergeBackRowDetails, mergeBackRowTitle, type MergeBackRow as Row } from '@shared/merge-back'
import { Button } from '../ui/button'
import { createRendererLogger } from '../../logger'
import { MergeBackDialog } from './MergeBackDialog'

const log = createRendererLogger('chat:merge-back-row')

export function MergeBackRow({ row, messageId, sessionId }: {
  row: Row
  messageId: string
  sessionId: string | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const details = mergeBackRowDetails(row)

  const discard = async () => {
    // Nothing is lost: the fork can send the same work again.
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.provider.mergeBackDiscard(sessionId, row.id)
      if (!result.ok) setError(result.message)
    } catch (err) {
      log.warn('discarding a merge-back failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (row.state === 'delivered') {
    return (
      <div
        data-message-id={messageId}
        data-testid="merge-back-row"
        data-state="delivered"
        className="mx-4 my-2 rounded-[8px] border border-dashed border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
      >
        <details>
          <summary className="cursor-pointer font-[600] text-[var(--text-primary)]">{mergeBackRowTitle(row)}</summary>
          <div className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text}</div>
        </details>
      </div>
    )
  }

  return (
    <div
      data-message-id={messageId}
      data-testid="merge-back-row"
      data-state="pending"
      className="mx-4 my-2 rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3 text-[12px] text-[var(--text-secondary)]"
    >
      <div className="mb-1.5 text-[13px] font-[600] text-[var(--text-primary)]">{mergeBackRowTitle(row)}</div>
      <ul className="mb-2.5 ml-[18px] list-disc [overflow-wrap:anywhere]">
        {details.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy || !sessionId} onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="outline" size="sm" disabled={busy || !sessionId} onClick={() => void discard()}>Discard</Button>
        <span className="text-[var(--text-muted)]">Goes to the agent with your next message.</span>
      </div>
      {error && <div role="alert" className="mt-1.5 text-[var(--error)]">{error}</div>}
      {editing && sessionId && (
        <MergeBackDialog
          mode={{ kind: 'edit', parentSessionId: sessionId, mergeBackId: row.id, forkTitle: row.forkTitle, text: row.text }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}
