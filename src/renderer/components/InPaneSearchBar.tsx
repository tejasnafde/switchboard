import { useEffect, useRef, useState } from 'react'
import { matchesShortcut } from '@shared/shortcuts'
import { cn } from '../lib/utils'

/**
 * Small floating search bar used by both `TerminalPane` and `ChatPanel`
 * for ⌘F in-pane search. Surface-agnostic - the parent owns the actual
 * search algorithm and just hands us callbacks.
 *
 * Behavior:
 *  - Mounts focused. ⌘F again is a no-op (parent decides whether to
 *    re-focus the input or no-op).
 *  - Enter → onNext, Shift+Enter → onPrev, Escape → onClose.
 *  - Input is debounced via React state - every change calls onQuery
 *    so the parent can run the search (terminal: searchAddon.findNext;
 *    chat: filter messages list).
 */
export interface InPaneSearchBarProps {
  /** Called every time the query changes (use for incremental search). */
  onQuery: (q: string) => void
  /** Move to next match. */
  onNext: () => void
  /** Move to previous match. */
  onPrev: () => void
  /** Close + clear search highlights. */
  onClose: () => void
  /** Optional match count display. `null` = hide; `{current, total}` = show "1/12". */
  matches?: { current: number; total: number } | null
  /** Optional placeholder. */
  placeholder?: string
  /** Text the bar opens with (the parent has already searched for it). */
  initialValue?: string
}

export function InPaneSearchBar({
  onQuery,
  onNext,
  onPrev,
  onClose,
  matches,
  placeholder = 'Find',
  initialValue = '',
}: InPaneSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div
      // Stop pointer events from reaching whatever is rendered behind the
      // bar (terminal LivePane has `onClick={onFocus}` which calls
      // `terminal.focus()` and yanks focus right back from our input).
      // mousedown is the one that matters - focus moves on mousedown,
      // not click - so we capture it before xterm's listener fires.
      // Bubble-phase handlers - stopping propagation in the capture phase
      // also blocks descendant onClick / onMouseDown (the × button), so
      // the close button never fires (and the user has to click the
      // input + press Escape to dismiss). Bubble phase runs AFTER the
      // descendants, which is exactly what we want here.
      onMouseDown={(e) => {
        // Re-assert input focus on the next tick. If the user clicked on
        // a non-input child (the gap, the count span), the browser's
        // default would defocus the input; instead we keep the caret in
        // the search box so typing keeps working.
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
          e.preventDefault()
          requestAnimationFrame(() => inputRef.current?.focus())
        }
        // Block propagation up to the underlying terminal / chat pane,
        // which would otherwise yank focus away from us.
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
      // stopPropagation so keystrokes typed in the search box don't bubble
      // up to the pane's ⌘F handler (which would re-focus or close it).
      onKeyDown={(e) => {
        // Stop ALL keys from bubbling out of the search bar - otherwise
        // pressing arrow keys would also drive the chat textarea or the
        // terminal underneath.
        const run = matchesShortcut(e, 'search.close') ? onClose
          : matchesShortcut(e, 'search.next') ? onNext
          : matchesShortcut(e, 'search.prev') ? onPrev
          : null
        if (run) {
          e.preventDefault()
          e.stopPropagation()
          run()
        }
      }}
      // Hardcoded opaque background - `var(--bg-secondary)` is alpha-blended
      // in the glass theme and the bar has to read clearly over terminal /
      // chat content, so we don't honor that variable here.
      className="absolute top-[8px] right-[12px] z-[20] flex items-center gap-[6px] rounded-[6px] border border-[#3a3f4a] bg-[#1a1d24] px-[8px] py-[6px] text-[12px] text-[var(--text-primary)] shadow-[0_10px_32px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.4)]"
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          onQuery(e.target.value)
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="w-[200px] rounded-[4px] border border-[#2f343d] bg-[#0e0f12] px-[8px] py-[4px] text-[12px] text-[#e6e8ec] [font-family:inherit] outline-none"
      />
      {matches && (
        <span
          className={cn(
            'min-w-[36px] text-right text-[11px] [font-family:var(--font-mono,monospace)]',
            matches.total === 0 ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {matches.total === 0 ? '0' : `${matches.current}/${matches.total}`}
        </span>
      )}
      <button
        type="button"
        // mousedown.preventDefault keeps the input focused so subsequent
        // Enter / ↑ / ↓ continue navigating without re-clicking.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { onPrev(); inputRef.current?.focus() }}
        title="Previous match (Shift+Enter / ↑)"
        className={ICON_BUTTON}
      >
        ↑
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { onNext(); inputRef.current?.focus() }}
        title="Next match (Enter / ↓)"
        className={ICON_BUTTON}
      >
        ↓
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        title="Close (Esc)"
        className={ICON_BUTTON}
      >
        ×
      </button>
    </div>
  )
}

const ICON_BUTTON = 'cursor-pointer rounded-[3px] border border-transparent bg-transparent px-[6px] py-[2px] text-[12px] leading-[1] text-[var(--text-secondary)] [font-family:inherit]'
