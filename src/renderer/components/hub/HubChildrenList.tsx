/**
 * A parent's children, as the chat header's Hub chip shows them: a line with
 * the counts, this chat's own state and the updates waiting, then one row per
 * unsettled child with its state, its newest update, its account and tokens,
 * and Open, Resume, Nudge and Stop. Rows come from the backend's hub view, so
 * every client shows the same states.
 *
 * It lives in the header popover and in the narrow header's "..." menu; it was
 * a strip above the composer until 2026-11-07.
 */
import {
  canResumeHubChild,
  canStopHubChild,
  childStateLabel,
  hubChildStopTarget,
  hubHeldUpdatesText,
  parentStateLabel,
  HUB_HELD_UPDATES_HINT,
  type HubChatRef,
  type HubChatView,
  type HubChildView,
} from '@shared/hub'
import { agentMarkLabel } from '@shared/agent-marks'
import { AgentMark } from '../ui/agent-mark'
import { createRendererLogger } from '../../logger'
import { hubChildDot } from './child-dot'
import { confirm } from '../ui/confirm'
import { nudgeChild, openHubChat } from './hub-actions'
import { MachineBadge } from './MachineBadge'

const log = createRendererLogger('hub:children')

const ATTENTION = new Set<HubChildView['state']>(['needs_you', 'asked_hub', 'blocked', 'failed'])

const textAction = 'cursor-pointer border-0 bg-transparent p-0 [font:inherit] hover:underline'
const linkClass = `${textAction} text-[var(--accent)]`
const stopClass = `${textAction} text-[var(--error)]`

function stopChild(parent: HubChatRef, child: HubChildView): void {
  const target = hubChildStopTarget(child)
  if (!target) return
  window.api.provider
    .interruptHubChild(parent.familyIds, target)
    .catch((err: unknown) => log.warn('stopping a child failed', err))
}

/** A Resume the backend refused (no session, already working, no armed resume) says so, rather than doing nothing. */
function resumeRefused(child: HubChildView, message: string | undefined): void {
  log.warn(`resuming ${child.chat.title} did nothing: ${message ?? 'no reason given'}`)
  void confirm({
    title: `${child.chat.title} did not resume`,
    body: message ?? 'Switchboard could not start its next turn.',
    confirmLabel: 'OK',
    notice: true,
  })
}

function resumeChild(parent: HubChatRef, child: HubChildView): void {
  window.api.provider
    .hubResumeChild(parent.familyIds, parent.id, child.chat.id)
    .then((result) => {
      if (!result.ok) resumeRefused(child, result.message)
    })
    .catch((err: unknown) => resumeRefused(child, err instanceof Error ? err.message : String(err)))
}

/** Every open child, with the parent's updates held until its next message or Show now. */
function stopAll(parent: HubChatRef): void {
  window.api.provider
    .hubStopChildren(parent.familyIds, parent.id)
    .catch((err: unknown) => log.warn('stopping the children failed', err))
}

function deliverHeld(parent: HubChatRef): void {
  window.api.provider
    .hubDeliverHeldWakes(parent.id)
    .catch((err: unknown) => log.warn('showing the held updates failed', err))
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`

/** The token figure of a row or the header, or null: an unknown or empty count says nothing. */
export function hubTokenText(tokens: number | null | undefined): string | null {
  return tokens != null && tokens >= 1000 ? kTokens(tokens) : null
}

function ChildRow({ parent, child, onOpened }: { parent: HubChatRef; child: HubChildView; onOpened: () => void }) {
  const tokens = hubTokenText(child.lastTurn?.usedTokens)
  const muted = [child.account, tokens].filter(Boolean)
  const agent = child.chat.agentType
  return (
    <li
      data-hub-child={child.state}
      title={[agentMarkLabel(agent), child.branch].filter(Boolean).join(' · ')}
      className="border-t border-[var(--border)] px-3 py-[6px] first:border-t-0"
    >
      <div className="flex min-w-0 items-center gap-[8px]">
        <span className="sidebar-recent-dot" data-dot={hubChildDot(child)} />
        <AgentMark agent={agent} label={agentMarkLabel(agent)} className="text-[var(--text-muted)]" />
        <span title={child.chat.title} className="min-w-0 truncate text-[var(--text-primary)]">
          {child.chat.title}
        </span>
        {child.remote && <MachineBadge name={child.remote.machine} className="max-w-[40%]" />}
      </div>
      <div className={`truncate pl-[15px] ${ATTENTION.has(child.state) ? 'text-[var(--text-primary)]' : ''}`}>
        {childStateLabel(child)}
        {child.lastWake && `: ${child.lastWake.summary}`}
        {muted.length > 0 && <span className="text-[var(--text-muted)]"> · {muted.join(' · ')}</span>}
      </div>
      <div className="flex flex-wrap gap-x-[10px] pl-[15px] whitespace-nowrap">
        <button
          type="button"
          className={linkClass}
          onClick={() => {
            onOpened()
            void openHubChat(child.chat, parent)
          }}
        >
          Open
        </button>
        {canResumeHubChild(child) && (
          <button type="button" className={linkClass} onClick={() => resumeChild(parent, child)}>
            Resume
          </button>
        )}
        <button
          type="button"
          className={linkClass}
          onClick={() => {
            onOpened()
            void nudgeChild(parent, child.chat)
          }}
        >
          Nudge
        </button>
        {canStopHubChild(child) && (
          <button type="button" className={stopClass} onClick={() => stopChild(parent, child)}>
            Stop
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * `onDone` closes whatever holds the list, for an action that moves the user
 * somewhere else (Open, Nudge). Stop, Resume and Show now leave it open, so
 * the rows under it show what happened.
 */
export function HubChildrenList({ view, onDone }: { view: HubChatView; onDone: () => void }) {
  const parent = view.self
  const items = view.children
  const heldUpdates = view.heldUpdates ?? 0
  if (!parent || (items.length === 0 && heldUpdates === 0)) return null
  const running = items.filter((c) => c.state === 'working').length
  const stoppable = items.filter(canStopHubChild)
  const tokens = hubTokenText(items.reduce((sum, c) => sum + (c.lastTurn?.usedTokens ?? 0), 0))
  const stateLabel = parentStateLabel(view.state)
  return (
    <section
      aria-label="Child chats"
      data-testid="hub-children-list"
      className="text-[12px] text-[var(--text-secondary)]"
    >
      <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[2px] border-b border-[var(--border)] px-3 py-[6px] whitespace-nowrap">
        <span>
          {items.length} open · {running} running
        </span>
        {stateLabel && <span className="min-w-0 truncate">{stateLabel}</span>}
        <span className="flex-1" />
        {tokens && <span>{tokens} tokens</span>}
        {stoppable.length > 0 && (
          <button type="button" className={stopClass} onClick={() => stopAll(parent)}>
            Stop all
          </button>
        )}
      </div>
      {heldUpdates > 0 && (
        <div
          title={HUB_HELD_UPDATES_HINT}
          className="flex items-baseline gap-x-[10px] border-b border-[var(--border)] px-3 py-[6px]"
        >
          <span className="text-[var(--warning)]">{hubHeldUpdatesText(heldUpdates)}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
            for this chat&apos;s next idle moment
          </span>
          <button type="button" className={linkClass} onClick={() => deliverHeld(parent)}>
            Show now
          </button>
        </div>
      )}
      <ul className="m-0 max-h-[320px] list-none overflow-y-auto p-0">
        {items.map((c) => (
          <ChildRow key={c.chat.id} parent={parent} child={c} onOpened={onDone} />
        ))}
      </ul>
    </section>
  )
}
