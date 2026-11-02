import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { undoLastSettle } from '../../services/chat-settle'
import { UNDO_BINDING, undoKeyName } from '../../services/global-keybindings'
import { formatBinding } from '@shared/shortcuts'
import { settledNoticeText } from '@shared/chat-settle'
import { focusRecentRow } from './recent-row-focus'

export const SETTLE_NOTICE_MS = 8000

/**
 * The sidebar footer's one-level Undo for a settle, above the Create row so it
 * never covers a row. A polite live region says the same, with the keys.
 */
export function SettleNotice() {
  const undo = useAgentStore((s) => s.lastUndo)

  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => {
      if (useAgentStore.getState().lastUndo === undo) useAgentStore.getState().setLastUndo(null)
    }, SETTLE_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [undo])

  const text = undo ? settledNoticeText(undo.title, undo.prNumber) : ''
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {undo ? `${text}. Press ${undoKeyName()} to undo.` : ''}
      </span>
      {undo && (
        <div className="flex w-full min-w-0 items-center gap-[6px] text-[11px] text-[var(--text-secondary)]">
          <span className="min-w-0 flex-1 truncate" title={text}>
            {'Settled '}
            <span className="text-[var(--text-primary)]">{undo.title}</span>
            {undo.prNumber === undefined ? '' : `: PR #${undo.prNumber} merged`}
          </span>
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-[3px] border-0 bg-transparent px-[3px] text-[11px] text-[var(--accent)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-hover)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]"
            onClick={() => {
              const restored = undoLastSettle()
              if (restored) focusRecentRow(restored)
            }}
          >
            Undo
          </button>
          <kbd className="shrink-0 rounded-[3px] bg-[var(--bg-tertiary)] px-[4px] [font-family:inherit] text-[11px] text-[var(--text-muted)]">
            {formatBinding(UNDO_BINDING)}
          </kbd>
        </div>
      )}
    </>
  )
}
