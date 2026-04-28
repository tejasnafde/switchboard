import { useEffect, useRef, useState } from 'react'

interface SidebarFilterProps {
  /** Debounced filter value flows up via this callback. */
  onChange: (query: string) => void
  /** Optional placeholder override. */
  placeholder?: string
}

/**
 * Tiny controlled filter input that lives at the top of the sidebar.
 * Debounced 100ms — fast enough to feel live, slow enough to not flicker
 * the whole tree on every keystroke when there are hundreds of sessions.
 *
 * Doesn't own the filtered tree; just emits the current query string.
 * The Sidebar renders against `applySidebarFilter(query, groups)` itself.
 */
export function SidebarFilter({ onChange, placeholder }: SidebarFilterProps) {
  const [value, setValue] = useState('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      onChange(value)
    }, 100)
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [value, onChange])

  return (
    <div className="sidebar-filter">
      <span className="sidebar-filter-glyph" aria-hidden>{'⌕'}</span>
      <input
        type="text"
        value={value}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder ?? 'filter chats…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            setValue('')
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="sidebar-filter-clear"
          onClick={() => setValue('')}
          title="Clear (Esc)"
          aria-label="Clear filter"
        >
          {'×'}
        </button>
      )}
    </div>
  )
}
