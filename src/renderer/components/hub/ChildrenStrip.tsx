/**
 * The children strip above a parent's composer: one row per unsettled child
 * with its state, account, branch, last turn and last update, and Open, Nudge
 * and Stop. Rows come from the backend's hub view, so every client shows the
 * same states.
 */
import { childStateLabel, type HubChatRef, type HubChildView } from '@shared/hub'
import { agentLabel, type AgentType } from '@shared/types'
import { createRendererLogger } from '../../logger'
import { Button } from '../ui/button'
import { nudgeChild, openHubChat } from './hub-actions'

const log = createRendererLogger('hub:strip')

const ATTENTION = new Set<HubChildView['state']>(['needs_you', 'asked_hub', 'blocked', 'failed', 'limited'])

function stopChild(parent: HubChatRef, child: HubChildView): void {
  if (!child.liveId) return
  window.api.provider
    .interruptHubChild(parent.familyIds, child.liveId)
    .catch((err: unknown) => log.warn('stopping a child failed', err))
}

function ChildRow({ parent, child }: { parent: HubChatRef; child: HubChildView }) {
  const facts = [
    agentLabel(child.chat.agentType as AgentType),
    child.account,
    child.branch,
    child.lastTurn?.usedTokens != null ? `${Math.round(child.lastTurn.usedTokens / 1000)}k tokens` : null,
    child.lastTurn?.costUsd != null ? `known cost $${child.lastTurn.costUsd.toFixed(2)}` : null,
  ].filter(Boolean)
  return (
    <li data-hub-child={child.state} className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] py-[4px]">
      <div className="min-w-[min(100%,240px)] flex-1">
        <div className="flex flex-wrap items-baseline gap-x-[8px]">
          <span className="max-w-full truncate text-[12px] font-[600] text-[var(--text-primary)]">
            {child.chat.title}
          </span>
          <span
            className={
              ATTENTION.has(child.state) ? 'shrink-0 text-[11px] text-[var(--warning)]' : 'shrink-0 text-[11px]'
            }
          >
            {childStateLabel(child)}
          </span>
        </div>
        <div className="truncate text-[11px] text-[var(--text-muted)]">{facts.join(' · ')}</div>
        {child.lastWake && (
          <div className="truncate text-[11px]" title={child.lastWake.summary}>
            {child.lastWake.summary}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-[4px]">
        <Button variant="ghost" size="sm" onClick={() => void openHubChat(child.chat, parent)}>
          Open
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void nudgeChild(parent, child.chat)}>
          Nudge
        </Button>
        {child.state === 'working' && child.liveId && (
          <Button variant="destructive-outline" size="sm" onClick={() => stopChild(parent, child)}>
            Stop
          </Button>
        )}
      </div>
    </li>
  )
}

export function ChildrenStrip({ parent, items }: { parent: HubChatRef; items: HubChildView[] }) {
  if (items.length === 0) return null
  return (
    <section
      aria-label="Child chats"
      data-testid="hub-children-strip"
      className="mx-6 mb-2 max-h-[30vh] overflow-y-auto rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[var(--text-secondary)]"
    >
      <div className="text-[11px] font-[600] uppercase tracking-[0.04em] text-[var(--text-muted)]">
        Children · {items.length}
      </div>
      <ul className="m-0 list-none p-0">
        {items.map((c) => (
          <ChildRow key={c.chat.id} parent={parent} child={c} />
        ))}
      </ul>
    </section>
  )
}
