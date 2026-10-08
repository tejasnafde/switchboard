/**
 * Conversations tab: inline review threads, Open or Resolved, each with its
 * reply box and Resolve. A thread's path opens that file in the Files tab.
 */
import { useState } from 'react'
import type { PrConversation, PrSummary } from '@shared/pull-requests'
import { conversationItem } from '@shared/review-context'
import { useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Loaded, usePrResource } from './PrDetailPane'
import { ConversationThread } from './PrDiff'
import { PendingReviewBar } from './PrReviewForm'
import { Icon } from './review-ui'
import { askAgent, filesFor } from './review-to-chat'

/** Hands conversations to the agent with the diff around each line. */
async function askAboutConversations(pr: PrSummary, conversations: PrConversation[]): Promise<void> {
  const files = await filesFor(pr.ref)
  await askAgent({
    pr: pr.ref,
    title: pr.title,
    url: pr.url,
    items: conversations.map((c) => conversationItem(c, files)),
  })
}

export function PrConversations({ summary, now }: { summary: PrSummary; now: number }) {
  const { value, retry } = usePrResource(summary, 'conversations')
  return (
    <Loaded value={value} retry={retry}>
      {(data) => <ConversationList pr={summary} conversations={data} now={now} />}
    </Loaded>
  )
}

function ConversationList({ pr, conversations, now }: { pr: PrSummary; conversations: PrConversation[]; now: number }) {
  const [show, setShow] = useState<'open' | 'resolved'>('open')
  const openFile = useReviewStore((s) => s.openFile)
  const open = conversations.filter((c) => !c.resolved)
  const resolved = conversations.filter((c) => c.resolved)
  const shown = show === 'open' ? open : resolved

  return (
    <>
      <PendingReviewBar pr={pr} />
      <div className="max-w-[900px] px-[22px] py-[18px]">
        <div
          role="tablist"
          aria-label="Conversation state"
          className="mb-3 inline-flex gap-[2px] rounded-[7px] border border-[var(--border)] bg-[var(--bg-surface)] p-[2px]"
        >
          {(['open', 'resolved'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={show === id}
              onClick={() => setShow(id)}
              className={cn(
                'cursor-pointer rounded-[5px] border-none px-[10px] py-[3px] text-[12px]',
                show === id
                  ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  : 'bg-transparent text-[var(--text-secondary)]',
              )}
            >
              {id === 'open' ? 'Open' : 'Resolved'}{' '}
              <span className="tabular-nums">{id === 'open' ? open.length : resolved.length}</span>
            </button>
          ))}
        </div>
        {show === 'open' && open.length > 1 && (
          <div className="mb-[10px] flex items-center gap-[10px] rounded-[10px] border border-dashed border-[var(--border-strong,var(--border))] px-3 py-[8px] text-[12.5px] text-[var(--text-secondary)]">
            <span className="min-w-0 flex-1">Hand every open conversation to the agent as one attachment.</span>
            <Button variant="outline" size="sm" onClick={() => void askAboutConversations(pr, open)}>
              <Icon name="spark" />
              Send all {open.length} open conversations
            </Button>
          </div>
        )}
        {shown.length === 0 && (
          <div className="text-[12.5px] text-[var(--text-muted)]">
            {show === 'open' ? 'No open conversations.' : 'No resolved conversations.'}
          </div>
        )}
        {shown.map((c) => (
          <div
            key={c.id}
            className="mb-[10px] overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]"
          >
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-[6px]">
              {c.path ? (
                <button
                  type="button"
                  onClick={() => openFile(c.path!)}
                  className="cursor-pointer truncate border-none bg-transparent p-0 font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-primary)] hover:underline"
                >
                  {c.path}
                  {c.line !== null && `:${c.startLine !== undefined ? `${c.startLine}-` : ''}${c.line}`}
                </button>
              ) : (
                <span className="text-[12px] text-[var(--text-secondary)]">On the pull request</span>
              )}
              {c.outdated && <span className="text-[12px] text-[var(--text-muted)]">outdated</span>}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void askAboutConversations(pr, [c])}>
                <Icon name="spark" />
                Ask the agent
              </Button>
            </div>
            <ConversationThread
              conversation={c}
              now={now}
              markResolved={false}
              pr={pr}
              className="rounded-none border-none"
            />
          </div>
        ))}
      </div>
    </>
  )
}
