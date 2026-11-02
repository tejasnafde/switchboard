import { useAgentStore, type LastUndo } from '../../stores/agent-store'
import { undoLastInbox } from '../../services/chat-inbox'
import { UNDO_BINDING, undoKeyName } from '../../services/global-keybindings'
import { formatBinding } from '@shared/shortcuts'
import { prNumberOf, wakeLabel } from '@shared/chat-snooze'
import { focusRecentRow } from './recent-row-focus'

/** The notice's words: what was done, the chat, and a tail a narrow sidebar drops. */
export function undoNoticeParts(undo: LastUndo, now: Date): { verb: string; title: string; tail: string } {
  switch (undo.kind) {
    case 'settle':
      return {
        verb: 'Settled',
        title: undo.title,
        tail: undo.prNumber === undefined ? '' : `: PR #${undo.prNumber} merged`,
      }
    case 'snooze':
      return {
        verb: 'Snoozed',
        title: undo.title,
        tail:
          undo.until !== null
            ? ` until ${wakeLabel(undo.until, null, now)}`
            : undo.pr
              ? ` until PR #${prNumberOf(undo.pr)} changes`
              : '',
      }
    case 'wake':
      return { verb: 'Woke', title: undo.title, tail: '' }
  }
}

/**
 * The sidebar footer's one-level Undo for Settle, Snooze and Wake, above the
 * Create row so it never covers a row, and a refused action's short notice.
 * A polite live region says the same, with the keys.
 */
export function InboxNotice() {
  const undo = useAgentStore((s) => s.lastUndo)
  const notice = useAgentStore((s) => s.inboxNotice)
  const parts = undo ? undoNoticeParts(undo, new Date()) : null
  const text = parts ? `${parts.verb} ${parts.title}${parts.tail}` : ''
  const spoken = [notice, parts ? `${text}. Press ${undoKeyName()} to undo.` : ''].filter(Boolean).join('. ')
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {spoken}
      </span>
      {notice && <div className="sidebar-inbox-notice sidebar-inbox-refusal">{notice}</div>}
      {parts && (
        <div className="sidebar-inbox-notice">
          <span className="sidebar-inbox-text" title={text}>
            {`${parts.verb} `}
            <span className="sidebar-inbox-title">{parts.title}</span>
            {parts.tail && <span className="sidebar-inbox-tail">{parts.tail}</span>}
          </span>
          <button
            type="button"
            className="sidebar-inbox-undo"
            onClick={() => {
              const restored = undoLastInbox()
              if (restored) focusRecentRow(restored)
            }}
          >
            Undo
          </button>
          <kbd className="sidebar-inbox-key">{formatBinding(UNDO_BINDING)}</kbd>
        </div>
      )}
    </>
  )
}
