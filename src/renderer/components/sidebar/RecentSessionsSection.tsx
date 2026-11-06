import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import type { RecentSessionItem } from './recent-sessions'
import { SessionAgentMark } from './SessionAgentMark'
import { RelativeTimeLabel, WakeTimeLabel } from './RelativeTimeLabel'
import { DEFAULT_RECENT_SESSION_LIMIT, type RecentSessionLimit } from './recent-session-limit'
import { RECENT_DOT_LABELS, groupRecentSessions, isWokeItem, recentDot, type RecentGroupKey } from './recent-groups'
import { useRenderCount } from '../../services/render-counter'
import { choiceStands, type SnoozeChoice } from '../../services/chat-inbox'
import { focusRecentRow, neighbourAfterRemoval } from './recent-row-focus'
import { SnoozeMenu, type SnoozeMenuExtra, type SnoozePrChoice } from './SnoozeMenu'

/** What the rows need for Snooze; without it they offer none. */
export interface RecentSnoozeProps {
  /** Whether the chat's machine takes Snooze. */
  available: (item: RecentSessionItem) => boolean
  /** Resolves false when the snooze did not happen and the row came back. */
  onSnooze: (item: RecentSessionItem, choice: SnoozeChoice) => Promise<boolean>
  onWake: (item: RecentSessionItem) => void
  loadPr: (item: RecentSessionItem) => Promise<SnoozePrChoice | null>
  /** The Snoozed group is shut (the default). */
  collapsed: boolean
  onSetCollapsed: (collapsed: boolean) => void
}

const ROW_SELECTOR = '.sidebar-recent-row-button'

export function RecentSessionsSection({
  items,
  initialLimit = DEFAULT_RECENT_SESSION_LIMIT,
  activeSessionId,
  displayedSessionIds = [],
  onSelect,
  onSettle,
  snooze,
  onContextMenu,
}: {
  items: RecentSessionItem[]
  initialLimit?: RecentSessionLimit
  activeSessionId: string | null
  displayedSessionIds?: readonly (string | null)[]
  onSelect: (item: RecentSessionItem) => void
  /** Settle a "Done recently" row (false when it came back); without it the rows offer no Settle. */
  onSettle?: (item: RecentSessionItem) => Promise<boolean>
  snooze?: RecentSnoozeProps
  /** Right-click on a row: the chat's context menu. */
  onContextMenu?: (item: RecentSessionItem, event: MouseEvent) => void
}) {
  useRenderCount('RecentSessionsSection')
  const [revealedCount, setRevealedCount] = useState(0)
  useEffect(() => setRevealedCount(0), [initialLimit])
  const sectionRef = useRef<HTMLElement>(null)
  /** The row that holds keyboard focus, by chat id, so a redraw that replaces its element gives it back. */
  const focusedId = useRef<string | null>(null)

  useLayoutEffect(() => {
    const id = focusedId.current
    const active = document.activeElement
    if (!id || (active && active !== document.body)) return
    sectionRef.current?.querySelector<HTMLElement>(`${ROW_SELECTOR}[data-recent-id="${CSS.escape(id)}"]`)?.focus()
  })

  if (items.length === 0) return null
  const { groups, hiddenCount, nextRevealCount } = groupRecentSessions(items, initialLimit, revealedCount)
  const expanded = revealedCount > 0
  const snoozedOpen = snooze ? !snooze.collapsed : false
  const rowIds = groups
    .filter((group) => group.key !== 'snoozed' || snoozedOpen)
    .flatMap((group) => group.items.map((item) => item.session.id))

  /** Move focus off a row that is leaving the list. */
  const leave = (id: string) => {
    const next = neighbourAfterRemoval(rowIds, id)
    focusedId.current = next
    if (next) focusRecentRow(next)
    return next
  }

  /** A row that came back takes focus again, unless the user moved it since the handoff. */
  const leaveUntil = (id: string, done: Promise<boolean>) => {
    const handoff = leave(id)
    void done.then((ok) => {
      if (ok || focusedId.current !== handoff) return
      if (handoff === null && document.activeElement && document.activeElement !== document.body) return
      focusedId.current = id
      focusRecentRow(id)
    })
  }

  const renderRow = (item: RecentSessionItem, groupKey: RecentGroupKey) => {
    const id = item.session.id
    const title = item.session.title
    const snoozed = groupKey === 'snoozed'
    const woke = isWokeItem(item)
    const dot = snoozed ? 'snoozed' : recentDot(item.status)
    const active = activeSessionId === id
    const canSnooze = !!snooze && (groupKey === 'working' || groupKey === 'done') && snooze.available(item)
    const canSettle = groupKey === 'done' && onSettle !== undefined
    const canWake = !!snooze && snoozed && snooze.available(item)
    // A narrow sidebar folds Snooze and Settle into one "..." button (CSS), so the title keeps its room.
    const textActions = [canSnooze && 'Snooze', canSettle && 'Settle', canWake && 'Wake'].filter(
      (a): a is string => !!a,
    )
    const settle = () => {
      if (onSettle) leaveUntil(id, onSettle(item))
    }
    const pick = (choice: SnoozeChoice) => {
      if (!snooze) return
      const leaves = choiceStands(choice, Date.now())
      if (!leaves) focusRecentRow(id)
      const done = snooze.onSnooze(item, choice)
      if (leaves) leaveUntil(id, done)
    }
    const menuExtras: SnoozeMenuExtra[] = canSettle ? [{ label: 'Settle', onSelect: settle }] : []
    return (
      <div
        key={`${item.machineId}:${id}`}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault()
                onContextMenu(item, event)
              }
            : undefined
        }
        className={`sidebar-recent-row ${active ? 'active' : ''} ${displayedSessionIds.includes(id) ? 'displayed' : ''} ${textActions.length > 0 ? 'has-actions' : ''} ${canSnooze ? 'snoozeable' : ''} ${canSettle ? 'settleable' : ''} ${woke ? 'woke' : ''} ${snoozed ? 'snoozed' : ''}`}
      >
        <button
          type="button"
          className="sidebar-recent-row-button"
          data-recent-id={id}
          aria-current={active ? 'page' : undefined}
          onClick={() => {
            focusedId.current = id
            onSelect(item)
          }}
        >
          <span className="sidebar-recent-line">
            <span
              className="sidebar-recent-dot"
              data-dot={dot}
              role="img"
              aria-label={RECENT_DOT_LABELS[dot]}
              title={RECENT_DOT_LABELS[dot]}
            />
            <SessionAgentMark session={item.session} />
            <span className="sidebar-recent-title" title={title}>
              {title}
            </span>
            <span className="sidebar-recent-detail">
              {snoozed ? (
                <WakeTimeLabel
                  className="sidebar-recent-time"
                  until={item.session.snoozedUntil ?? null}
                  pr={item.session.snoozePr ?? null}
                />
              ) : woke ? (
                <span className="sidebar-recent-time">Woke</span>
              ) : (
                <RelativeTimeLabel className="sidebar-recent-time" timestamp={item.session.startedAt} />
              )}
              {textActions.length > 0 && (
                // Holds the width the actions take over the time, so the title shortens instead of hiding under them.
                <span className="sidebar-recent-actions-space" aria-hidden="true">
                  {textActions.map((action) => (
                    <span key={action} className={action === 'Wake' ? undefined : 'sidebar-recent-action-text'}>
                      {action}
                    </span>
                  ))}
                  {canSnooze && <span className="sidebar-recent-action-more">...</span>}
                </span>
              )}
            </span>
          </span>
          <span className="sidebar-recent-status" title={item.statusLine}>
            {item.statusLine}
          </span>
        </button>
        {textActions.length > 0 && (
          <span className="sidebar-recent-actions">
            {canSnooze && (
              <SnoozeMenu
                label={`Snooze ${title}`}
                className="sidebar-recent-action sidebar-recent-action-text"
                loadPr={() => snooze.loadPr(item)}
                onPick={pick}
                onTriggerGone={() => focusRecentRow(id)}
              >
                Snooze
              </SnoozeMenu>
            )}
            {canSettle && (
              <button
                type="button"
                className="sidebar-recent-action sidebar-recent-action-text"
                aria-label={`Settle ${title}`}
                title="Take this chat out of Done recently"
                onClick={settle}
              >
                Settle
              </button>
            )}
            {canSnooze && (
              <SnoozeMenu
                label={`Actions for ${title}`}
                className="sidebar-recent-action sidebar-recent-action-more"
                loadPr={() => snooze.loadPr(item)}
                extras={menuExtras}
                onPick={pick}
                onTriggerGone={() => focusRecentRow(id)}
              >
                ...
              </SnoozeMenu>
            )}
            {canWake && (
              <button
                type="button"
                className="sidebar-recent-action"
                aria-label={`Wake ${title}`}
                title="End the snooze now"
                onClick={() => {
                  leave(id)
                  snooze.onWake(item)
                }}
              >
                Wake
              </button>
            )}
          </span>
        )}
      </div>
    )
  }

  const renderGroup = (group: (typeof groups)[number]) =>
    group.key === 'snoozed' && snooze ? (
      <div key={group.key} className="sidebar-recent-group" data-group={group.key}>
        <button
          type="button"
          className="sidebar-section-label sidebar-recent-group-toggle"
          aria-expanded={snoozedOpen}
          onClick={() => snooze.onSetCollapsed(snoozedOpen)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
            event.preventDefault()
            snooze.onSetCollapsed(event.key === 'ArrowLeft')
          }}
        >
          <span>
            <svg className="sidebar-recent-chevron" viewBox="0 0 8 8" aria-hidden="true">
              <path d="M1.5 3l2.5 2.5L6.5 3" />
            </svg>
            {group.label}
          </span>
          <span className="sidebar-recent-count">{group.items.length}</span>
        </button>
        {snoozedOpen && group.items.map((item) => renderRow(item, group.key))}
      </div>
    ) : (
      <div key={group.key} className="sidebar-recent-group" data-group={group.key}>
        <div className="sidebar-section-label">
          <span>{group.label}</span>
          {group.key !== 'done' && <span className="sidebar-recent-count">{group.items.length}</span>}
        </div>
        {group.items.map((item) => renderRow(item, group.key))}
      </div>
    )

  const moreActions = (hiddenCount > 0 || expanded) && (
    <div className="sidebar-recents-actions">
      {hiddenCount > 0 && (
        <button
          type="button"
          className="sidebar-recents-more"
          aria-expanded={expanded}
          onClick={() => setRevealedCount(nextRevealCount)}
        >
          Show {nextRevealCount - revealedCount} more
        </button>
      )}
      {expanded && (
        <button type="button" className="sidebar-recents-more sidebar-recents-less" onClick={() => setRevealedCount(0)}>
          Show less
        </button>
      )}
    </div>
  )
  // "Show more" belongs to Done recently, above Snoozed, also while no Done row is shown.
  const moreAfter = groups.filter((group) => group.key !== 'snoozed').at(-1)?.key ?? groups[0]?.key

  return (
    <section
      ref={sectionRef}
      className="sidebar-recents"
      aria-label="Recent conversations"
      onFocusCapture={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR)?.dataset.recentId
        focusedId.current = id ?? null
      }}
      onBlurCapture={(event) => {
        // Focus that went elsewhere, or nowhere from a row still on screen, is the user's move.
        // A row a redraw removed blurs while detached, and the layout effect gives focus back.
        const next = event.relatedTarget as Node | null
        if (next ? !event.currentTarget.contains(next) : (event.target as Element).isConnected) focusedId.current = null
      }}
    >
      {groups.map((group) => (
        <Fragment key={group.key}>
          {renderGroup(group)}
          {group.key === moreAfter && moreActions}
        </Fragment>
      ))}
    </section>
  )
}
