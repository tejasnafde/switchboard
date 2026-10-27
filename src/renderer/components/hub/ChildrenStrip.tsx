/**
 * The children strip above a parent's composer: a header with the counts, the
 * parent state and the token total, then one line per unsettled child with
 * its state, last wake, account and tokens, and Open, Nudge and Stop. Rows
 * come from the backend's hub view, so every client shows the same states.
 */
import { useState } from 'react'
import { childStateLabel, parentStateLabel, type HubChatRef, type HubChildView, type ParentState } from '@shared/hub'
import { agentLabel, type AgentType } from '@shared/types'
import { createRendererLogger } from '../../logger'
import { childDot } from './child-dot'
import { nudgeChild, openHubChat } from './hub-actions'

const log = createRendererLogger('hub:strip')

const ATTENTION = new Set<HubChildView['state']>(['needs_you', 'asked_hub', 'blocked', 'failed'])
/** Rows shown before "Show all". */
const FOLDED_ROWS = 6

const textAction = 'cursor-pointer border-0 bg-transparent p-0 [font:inherit] hover:underline'
const linkClass = `${textAction} text-[var(--accent)]`
const stopClass = `${textAction} text-[var(--error)]`

const canStop = (c: HubChildView) => c.state === 'working' && c.liveId !== null

function stopChild(parent: HubChatRef, child: HubChildView): void {
  if (!child.liveId) return
  window.api.provider
    .interruptHubChild(parent.familyIds, child.liveId)
    .catch((err: unknown) => log.warn('stopping a child failed', err))
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`

function ChildRow({ parent, child }: { parent: HubChatRef; child: HubChildView }) {
  const tokens = child.lastTurn?.usedTokens
  const muted = [child.account, tokens != null ? kTokens(tokens) : null].filter(Boolean)
  return (
    <li
      data-hub-child={child.state}
      title={[agentLabel(child.chat.agentType as AgentType), child.branch].filter(Boolean).join(' · ')}
      className="grid grid-cols-[7px_minmax(120px,160px)_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[2px] border-t border-[var(--border)] px-3 py-[5px] @max-[420px]:grid-cols-[7px_minmax(0,1fr)]"
    >
      <span className="sidebar-recent-dot" data-dot={childDot(child.state)} />
      <span className="truncate text-[var(--text-primary)]">{child.chat.title}</span>
      <span
        className={`truncate @max-[420px]:col-start-2 ${ATTENTION.has(child.state) ? 'font-[500] text-[var(--text-primary)]' : ''}`}
      >
        {childStateLabel(child)}
        {child.lastWake && `: ${child.lastWake.summary}`}
        {muted.length > 0 && <span className="font-[400] text-[var(--text-muted)]"> · {muted.join(' · ')}</span>}
      </span>
      <span className="flex flex-wrap gap-x-[10px] whitespace-nowrap @max-[420px]:col-start-2">
        <button type="button" className={linkClass} onClick={() => void openHubChat(child.chat, parent)}>
          Open
        </button>
        <button type="button" className={linkClass} onClick={() => void nudgeChild(parent, child.chat)}>
          Nudge
        </button>
        {canStop(child) && (
          <button type="button" className={stopClass} onClick={() => stopChild(parent, child)}>
            Stop
          </button>
        )}
      </span>
    </li>
  )
}

export function ChildrenStrip({
  parent,
  items,
  state,
}: {
  parent: HubChatRef
  items: HubChildView[]
  state: ParentState | null
}) {
  const [showAll, setShowAll] = useState(false)
  if (items.length === 0) return null
  const running = items.filter((c) => c.state === 'working').length
  const stoppable = items.filter(canStop)
  const tokens = items.reduce((sum, c) => sum + (c.lastTurn?.usedTokens ?? 0), 0)
  const stateLabel = parentStateLabel(state)
  const shown = showAll ? items : items.slice(0, FOLDED_ROWS)
  return (
    <section
      aria-label="Child chats"
      data-testid="hub-children-strip"
      className="@container mx-6 mb-2 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]"
    >
      <div className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px] px-3 py-[6px] whitespace-nowrap">
        <b className="font-[600] text-[var(--text-primary)]">Children</b>
        <span>
          {items.length} open · {running} running
        </span>
        {stateLabel && <span className="min-w-0 truncate">{stateLabel}</span>}
        <span className="flex-1" />
        {tokens > 0 && <span>{kTokens(tokens)} tokens</span>}
        {items.length > FOLDED_ROWS && (
          <button type="button" className={linkClass} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        )}
        {stoppable.length > 0 && (
          <button type="button" className={stopClass} onClick={() => stoppable.forEach((c) => stopChild(parent, c))}>
            Stop all
          </button>
        )}
      </div>
      <ul className="m-0 max-h-[240px] list-none overflow-y-auto p-0">
        {shown.map((c) => (
          <ChildRow key={c.chat.id} parent={parent} child={c} />
        ))}
      </ul>
    </section>
  )
}
