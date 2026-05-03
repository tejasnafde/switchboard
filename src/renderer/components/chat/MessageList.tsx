import { useRef, useEffect, useCallback, useMemo } from 'react'
import { agentShortLabel, type AgentType, type ChatMessage } from '@shared/types'
import { MessageBubble } from './MessageBubble'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAgentStore } from '../../stores/agent-store'
import { useSkillStore } from '../../stores/skill-store'

interface MessageListProps {
  messages: ChatMessage[]
  sessionId?: string | null
  agentType?: AgentType
  onApproval?: (requestId: string, decision: 'approve' | 'deny', note?: string) => void
  onAnswerQuestion?: (requestId: string, answers: string[][]) => void
  onPlanAction?: (planId: string, action: 'implement' | 'iterate') => void
}

/**
 * Groups consecutive same-role messages into "turns".
 * A turn is a sequence of messages with the same role between role changes.
 * Each turn renders under a single role label (You/Claude/System) with a
 * shared timestamp.
 *
 * Exported for unit testing — the filter inside has regressed silently
 * (e.g. forgot to keep messages with only a `question` or `plan` attachment).
 */
export function groupIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  let currentGroup: ChatMessage[] = []
  let currentRole: string | null = null

  for (const msg of messages) {
    // Skip truly empty messages — but keep ones with any kind of attachment
    // (toolCalls / approval / question / plan / images / denial). Missing any
    // of these would hide the corresponding custom UI (QuestionCard,
    // PlanCard, DenialPill, etc).
    if (
      !msg.content &&
      !msg.toolCalls?.length &&
      !msg.approval &&
      !msg.question &&
      !msg.plan &&
      !msg.images?.length &&
      !msg.denial
    ) continue

    if (msg.role !== currentRole) {
      if (currentGroup.length > 0) groups.push(currentGroup)
      currentGroup = [msg]
      currentRole = msg.role
    } else {
      currentGroup.push(msg)
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  return groups
}

export function roleLabel(role: ChatMessage['role'], agentType: AgentType = 'claude-code'): string {
  if (role === 'user') return 'You'
  if (role === 'system') return 'System'
  return agentShortLabel(agentType)
}

/**
 * Virtualized message list.
 *
 * Uses @tanstack/react-virtual with dynamic row-height measurement so each
 * turn only mounts its DOM when scrolled into view. Keeps the existing
 * scroll-lock behavior (don't auto-scroll-to-bottom if the user has
 * scrolled up), and still snaps to the latest turn on new messages.
 *
 * Grouping into turns happens first, then each turn is a virtual row. This
 * matches the pre-virtualized layout exactly; tests for `groupIntoTurns`
 * still pass since the grouping is the same.
 */
export function MessageList({ messages, sessionId, agentType = 'claude-code', onApproval, onAnswerQuestion, onPlanAction }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isScrollLockedRef = useRef(false)
  const prevSessionIdRef = useRef<string | null | undefined>(sessionId)

  const turns = useMemo(() => groupIntoTurns(messages), [messages])

  // Skill-name set for the current session — passed to each bubble so
  // leading-`/cmd` chips only render for commands that actually exist.
  // Falls back to undefined when the session hasn't published yet, in
  // which case MessageBubble suppresses chip rendering rather than
  // showing false positives.
  const knownSkillNames = useSkillStore(
    (s) => (sessionId ? s.namesBySession[sessionId] : undefined),
  )

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => containerRef.current,
    // Rough estimate — the measurer corrects this on mount via the ref.
    // 120px covers a short chat bubble + role label + timestamp.
    estimateSize: () => 120,
    overscan: 6,
    // Track by first message id in a group so streaming updates to the
    // LAST turn don't invalidate earlier virtualized rows' measurements.
    getItemKey: (index) => turns[index]?.[0]?.id ?? index,
  })

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    isScrollLockedRef.current = distanceFromBottom > 50
  }, [])

  // Jump to bottom instantly when switching sessions — UNLESS the session
  // switch was triggered by a search-result click (pendingScrollToMessage
  // for this same sessionId is set). In that case, the pending-scroll
  // effect below will jump to the right row; we mustn't race it to the
  // bottom first.
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId
      const pending = useAgentStore.getState().pendingScrollToMessage
      const hasPendingForThis = pending && pending.sessionId === sessionId
      isScrollLockedRef.current = !!hasPendingForThis
      if (hasPendingForThis) return
      // Wait for measurement pass, then scroll to last item.
      requestAnimationFrame(() => {
        if (turns.length > 0) {
          virtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
        }
      })
    }
  }, [sessionId])

  // Auto-scroll-to-bottom on new messages (only if user hasn't scrolled up).
  // Same guard as above: if a pending search-jump is in flight for this
  // session, don't auto-scroll-bottom — the smooth animation would fight
  // the instant scrollToIndex from the pending-scroll effect and "win"
  // because smooth scrolls keep ticking after layout.
  useEffect(() => {
    if (isScrollLockedRef.current || turns.length === 0) return
    const pending = useAgentStore.getState().pendingScrollToMessage
    if (pending && pending.sessionId === sessionId) return
    // rAF so the newly-appended row has a chance to mount + measure
    // before we tell the virtualizer to jump to it.
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(turns.length - 1, { align: 'end', behavior: 'smooth' })
    })
  }, [messages.length])

  // Honor "scroll to message" requests (from SearchModal). Finds the turn
  // containing the target message, jumps the virtualizer there, then
  // briefly highlights the bubble. Clears the request so re-clicks work.
  const pendingScroll = useAgentStore((s) => s.pendingScrollToMessage)
  const clearScroll = useAgentStore((s) => s.clearScrollToMessage)
  useEffect(() => {
    if (!pendingScroll) return
    if (pendingScroll.sessionId !== sessionId) return
    const turnIdx = turns.findIndex((group) =>
      group.some((m) => m.id === pendingScroll.messageId),
    )
    if (turnIdx === -1) {
      // Message hasn't loaded into the session yet — may still be mid-load.
      // Leave the pending request; the next render after setMessages will
      // re-run this effect and find it.
      return
    }
    // Disable scroll-lock so the virtualizer's scrollToIndex isn't competing
    // with our auto-scroll-to-bottom effect.
    isScrollLockedRef.current = true
    // Two-pass scroll: the first scrollToIndex mounts the target row; row
    // mount triggers measurement; the SECOND scrollToIndex on the next
    // frame uses the now-correct measurements so the row is actually
    // centered (not just "somewhere in the viewport").
    const query = pendingScroll.query
    const targetMessageId = pendingScroll.messageId
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(turnIdx, { align: 'center' })
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(turnIdx, { align: 'center' })
        // Highlight pulse once the row is mounted by the virtualizer.
        setTimeout(() => {
          // Clean up any prior in-chat search marks (across all bubbles in
          // this list). Only the active match should look like the active
          // match.
          clearSearchMarks(containerRef.current)
          const el = document.querySelector<HTMLElement>(`[data-message-id="${targetMessageId}"]`)
          if (el) {
            if (query && query.trim()) {
              // Wrap the matched substring with <mark> instead of flashing
              // the whole bubble — much easier to spot the actual match.
              const wrapped = wrapSearchMatches(el, query)
              if (wrapped) {
                // Center the active mark so the user sees the phrase, not
                // just the bubble.
                wrapped.scrollIntoView({ block: 'center', behavior: 'auto' })
              } else {
                // No text-node match (rare — substring may be in markdown
                // syntax that React already split). Fall back to bubble
                // pulse.
                el.classList.add('message-search-highlight')
                setTimeout(() => el.classList.remove('message-search-highlight'), 1000)
              }
            } else {
              // Cross-chat ⌘⇧F (no query passed) keeps the old pulse.
              el.classList.add('message-search-highlight')
              setTimeout(() => el.classList.remove('message-search-highlight'), 1000)
            }
          }
        }, 80)
      })
    })
    clearScroll()
  }, [pendingScroll, sessionId, turns.length])

  if (turns.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: '14px',
          padding: '20px',
          textAlign: 'center',
        }}
      >
        <div>
          <div style={{ marginBottom: '12px', opacity: 0.4 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div>Start a conversation with your agent</div>
        </div>
      </div>
    )
  }

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px 0',
        // NOTE: deliberately NOT using `contain: strict` — it creates a new
        // containing block for `position: fixed` descendants, which breaks
        // the MessageBubble image lightbox (clips to the scroll container
        // instead of covering the viewport). The virtualizer alone provides
        // enough perf without CSS containment.
      }}
    >
      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((vi) => {
          const group = turns[vi.index]
          const role = group[0].role
          const isUser = role === 'user'
          const isSystem = role === 'system'
          const timestamp = group[group.length - 1].timestamp

          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
                marginBottom: '4px',
              }}
            >
              {/* Turn role label */}
              <div style={{
                padding: '4px 16px 0',
                fontSize: '11px',
                color: isSystem ? 'var(--warning)' : 'var(--text-muted)',
                fontWeight: 500,
                textAlign: isUser ? 'right' : 'left',
              }}>
                {roleLabel(role, agentType)}
              </div>

              {/* All messages in this turn */}
              {group.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  knownSkillNames={knownSkillNames}
                  onApproval={onApproval}
                  onAnswerQuestion={onAnswerQuestion}
                  onPlanAction={onPlanAction}
                />
              ))}

              {/* Turn timestamp */}
              <div style={{
                padding: '0 16px',
                fontSize: '10px',
                color: 'var(--text-muted)',
                opacity: 0.5,
                textAlign: isUser ? 'right' : 'left',
              }}>
                {new Date(timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── In-chat search highlight helpers ──────────────────────────────
// Walk the message bubble's text nodes and wrap the first occurrence
// of `query` (case-insensitive) with <mark class="sb-search-mark active">.
// Returns the wrapping <mark> so the caller can scroll it into view.
//
// We deliberately wrap only the FIRST match per bubble — the in-pane
// search bar steps through one match at a time (each step scrolls to
// a different message), so wrapping every occurrence would be visually
// noisy and steal focus from the active one.
function wrapSearchMatches(bubble: HTMLElement, query: string): HTMLElement | null {
  const q = query.trim()
  if (!q) return null
  // Use a TreeWalker rooted at the bubble. Skip <script>, <style>, and
  // anything inside an existing mark (don't double-wrap on consecutive
  // searches before clearSearchMarks runs).
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (parent.closest('mark.sb-search-mark')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const lower = q.toLowerCase()
  let textNode: Text | null = null
  let idx = -1
  while ((textNode = walker.nextNode() as Text | null)) {
    const value = textNode.nodeValue ?? ''
    idx = value.toLowerCase().indexOf(lower)
    if (idx >= 0) break
  }
  if (!textNode || idx < 0) return null
  const before = textNode.nodeValue!.slice(0, idx)
  const match = textNode.nodeValue!.slice(idx, idx + q.length)
  const after = textNode.nodeValue!.slice(idx + q.length)
  const mark = document.createElement('mark')
  mark.className = 'sb-search-mark active'
  mark.textContent = match
  const parent = textNode.parentNode!
  if (before) parent.insertBefore(document.createTextNode(before), textNode)
  parent.insertBefore(mark, textNode)
  if (after) parent.insertBefore(document.createTextNode(after), textNode)
  parent.removeChild(textNode)
  return mark
}

function clearSearchMarks(root: HTMLElement | null): void {
  if (!root) root = document.body
  const marks = root.querySelectorAll('mark.sb-search-mark')
  marks.forEach((m) => {
    const parent = m.parentNode
    if (!parent) return
    while (m.firstChild) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
    parent.normalize()
  })
}
