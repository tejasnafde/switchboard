import { useAgentStore, type LastUndo } from '../../stores/agent-store'
import { undoLastInbox } from '../../services/chat-inbox'
import { UNDO_BINDING, undoKeyName } from '../../services/global-keybindings'
import { formatBinding } from '@shared/shortcuts'
import { prNumberOf, wakeLabel } from '@shared/chat-snooze'
import { focusUndoneRow } from './recent-row-focus'

/**
 * The notice's words: what was done, the chat, and a tail (the wake time, the
 * merged PR) that a narrow sidebar moves to a second line. `joiner` ends the
 * first part: a colon before a merged PR.
 */
export function undoNoticeParts(
  undo: LastUndo,
  now: Date,
): { verb: string; title: string; joiner: string; tail: string } {
  switch (undo.kind) {
    case 'settle':
      return undo.prNumber === undefined
        ? { verb: 'Settled', title: undo.title, joiner: '', tail: '' }
        : { verb: 'Settled', title: undo.title, joiner: ':', tail: `PR #${undo.prNumber} merged` }
    case 'snooze':
      return {
        verb: 'Snoozed',
        title: undo.title,
        joiner: '',
        tail:
          undo.until !== null
            ? `until ${wakeLabel(undo.until, null, now)}`
            : undo.pr
              ? `until PR #${prNumberOf(undo.pr)} changes`
              : '',
      }
    case 'wake':
      return { verb: 'Woke', title: undo.title, joiner: '', tail: '' }
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
  const text = parts ? `${parts.verb} ${parts.title}${parts.joiner}${parts.tail ? ` ${parts.tail}` : ''}` : ''
  const spoken = [notice, parts ? `${text}. Press ${undoKeyName()} to undo.` : ''].filter(Boolean).join('. ')
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {spoken}
      </span>
      {notice && <div className="sidebar-inbox-notice sidebar-inbox-refusal">{notice}</div>}
      {parts && (
        <div className="sidebar-inbox-notice">
          <div className="sidebar-inbox-line">
            <span className="sidebar-inbox-text" title={text}>
              {`${parts.verb} `}
              <span className="sidebar-inbox-title">{parts.title}</span>
              {parts.joiner}
            </span>
            {parts.tail && <span className="sidebar-inbox-tail">{parts.tail}</span>}
            <button
              type="button"
              className="sidebar-inbox-undo"
              onClick={() => {
                const kind = undo?.kind ?? 'settle'
                const restored = undoLastInbox()
                if (restored) focusUndoneRow(restored, kind)
              }}
            >
              Undo
            </button>
            <kbd className="sidebar-inbox-key">{formatBinding(UNDO_BINDING)}</kbd>
          </div>
        </div>
      )}
    </>
  )
}
