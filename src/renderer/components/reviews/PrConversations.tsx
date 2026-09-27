/**
 * Conversations tab: inline review threads, Open or Resolved. A thread's
 * path opens that file in the Files tab.
 */
import { useState } from 'react'
import type { PrConversation, PrSummary } from '@shared/pull-requests'
import { useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Loaded, usePrResource } from './PrDetailPane'
import { ConversationThread } from './PrDiff'

export function PrConversations({ summary, now }: { summary: PrSummary; now: number }) {
  const { value, retry } = usePrResource(summary, 'conversations')
  return <Loaded value={value} retry={retry}>{(data) => <ConversationList conversations={data} now={now} />}</Loaded>
}

function ConversationList({ conversations, now }: { conversations: PrConversation[]; now: number }) {
  const [show, setShow] = useState<'open' | 'resolved'>('open')
  const openFile = useReviewStore((s) => s.openFile)
  const open = conversations.filter((c) => !c.resolved)
  const resolved = conversations.filter((c) => c.resolved)
  const shown = show === 'open' ? open : resolved

  return (
    <div className="max-w-[900px] px-[22px] py-[18px]">
      <div role="tablist" aria-label="Conversation state" className="mb-3 inline-flex gap-[2px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-surface)] p-[2px]">
        {(['open', 'resolved'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={show === id}
            onClick={() => setShow(id)}
            className={cn(
              'cursor-pointer rounded-[5px] border-none px-[10px] py-[3px] text-[12px]',
              show === id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]',
            )}
          >
            {id === 'open' ? 'Open' : 'Resolved'} <span className="tabular-nums">{id === 'open' ? open.length : resolved.length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 && (
        <div className="text-[12.5px] text-[var(--text-muted)]">{show === 'open' ? 'No open conversations.' : 'No resolved conversations.'}</div>
      )}
      {shown.map((c) => (
        <div key={c.id} className="mb-[10px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
          {c.path && (
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-[9px]">
              <button
                type="button"
                onClick={() => openFile(c.path!)}
                className="cursor-pointer truncate border-none bg-transparent p-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-primary)] hover:underline"
              >
                {c.path}{c.line !== null && `:${c.line}`}
              </button>
              {c.outdated && <span className="ml-auto text-[12px] text-[var(--text-muted)]">outdated</span>}
            </div>
          )}
          <ConversationThread conversation={c} now={now} markResolved={false} className="rounded-none border-none" />
        </div>
      ))}
    </div>
  )
}
