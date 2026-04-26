import { useEffect, useRef, useState } from 'react'

/**
 * Small floating search bar used by both `TerminalPane` and `ChatPanel`
 * for ⌘F in-pane search. Surface-agnostic — the parent owns the actual
 * search algorithm and just hands us callbacks.
 *
 * Behavior:
 *  - Mounts focused. ⌘F again is a no-op (parent decides whether to
 *    re-focus the input or no-op).
 *  - Enter → onNext, Shift+Enter → onPrev, Escape → onClose.
 *  - Input is debounced via React state — every change calls onQuery
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
}

export function InPaneSearchBar({
  onQuery,
  onNext,
  onPrev,
  onClose,
  matches,
  placeholder = 'Find',
}: InPaneSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <div
      // Stop pointer events from reaching whatever is rendered behind the
      // bar (terminal LivePane has `onClick={onFocus}` which calls
      // `terminal.focus()` and yanks focus right back from our input).
      // mousedown is the one that matters — focus moves on mousedown,
      // not click — so we capture it before xterm's listener fires.
      onMouseDownCapture={(e) => {
        e.stopPropagation()
        // Re-assert input focus on the next tick. If the user clicked on
        // a non-input child (the gap, the count span), the browser's
        // default would defocus the input; instead we keep the caret in
        // the search box so typing keeps working.
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && target.tagName !== 'BUTTON') {
          e.preventDefault()
          requestAnimationFrame(() => inputRef.current?.focus())
        }
      }}
      onClickCapture={(e) => e.stopPropagation()}
      // stopPropagation so keystrokes typed in the search box don't bubble
      // up to the pane's ⌘F handler (which would re-focus or close it).
      onKeyDown={(e) => {
        // Stop ALL keys from bubbling out of the search bar — otherwise
        // pressing arrow keys would also drive the chat textarea or the
        // terminal underneath.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) onPrev()
          else onNext()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          e.stopPropagation()
          onNext()
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          onPrev()
        } else if (e.key === 'F3' || (e.key === 'g' && (e.metaKey || e.ctrlKey))) {
          // ⌘G (macOS) / Ctrl+G (Windows/Linux) / F3 — "find next"
          // muscle memory across platforms.
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) onPrev()
          else onNext()
        }
      }}
      style={{
        position: 'absolute',
        top: 8,
        right: 12,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        // Hardcoded opaque background — `var(--bg-secondary)` is alpha-blended
        // in the glass theme and the bar has to read clearly over terminal /
        // chat content, so we don't honor that variable here.
        background: '#1a1d24',
        border: '1px solid #3a3f4a',
        borderRadius: 6,
        boxShadow: '0 10px 32px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4)',
        fontSize: 12,
        color: 'var(--text-primary)',
      }}
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
        style={{
          width: 200,
          padding: '4px 8px',
          background: '#0e0f12',
          border: '1px solid #2f343d',
          borderRadius: 4,
          color: '#e6e8ec',
          fontSize: 12,
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      {matches && (
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            color: matches.total === 0 ? 'var(--text-muted)' : 'var(--text-secondary)',
            minWidth: 36,
            textAlign: 'right',
          }}
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
        style={iconBtn}
      >
        ↑
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { onNext(); inputRef.current?.focus() }}
        title="Next match (Enter / ↓)"
        style={iconBtn}
      >
        ↓
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
        title="Close (Esc)"
        style={iconBtn}
      >
        ×
      </button>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: '2px 6px',
  borderRadius: 3,
  fontSize: 12,
  lineHeight: 1,
  fontFamily: 'inherit',
}
