import { useEffect, useMemo, useRef } from 'react'
import { filterAtMatches } from './atMention'

interface AtMentionMenuProps {
  query: string
  files: string[]
  loading?: boolean
  onSelect: (path: string) => void
  onDismiss: () => void
  activeIndex: number
  onActiveIndexChange: (idx: number) => void
}

/**
 * Inline popover listing files matching an `@<query>` trigger in the chat
 * input. Mirrors `SlashCommandMenu`'s layout + keyboard model so navigation
 * feels identical: ↑↓/Enter/Esc forwarded by the parent textarea via
 * `activeIndex` + `onActiveIndexChange`.
 *
 * Scoring reuses the ⌘P fuzzyScore so basename/dir-prefix priorities stay
 * consistent across the file-finder and the at-mention.
 */
export function AtMentionMenu({
  query,
  files,
  loading,
  onSelect,
  onDismiss,
  activeIndex,
  onActiveIndexChange,
}: AtMentionMenuProps) {
  const matches = useMemo(() => filterAtMatches(query, files), [files, query])

  useEffect(() => {
    onActiveIndexChange(0)
  }, [query, matches.length, onActiveIndexChange])

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const el = itemRefs.current[activeIndex]
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [activeIndex])

  if (matches.length === 0) {
    return (
      <div className="sb-floating-surface" style={popoverStyle}>
        <div style={{
          padding: '8px 12px',
          fontSize: '12px',
          color: 'var(--text-muted)',
          fontStyle: 'italic',
        }}>
          {loading ? 'Loading files…' : `No files match "@${query}"`}
        </div>
        <div style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          <kbd style={kbdStyle}>Esc</kbd> to dismiss
        </div>
      </div>
    )
  }

  return (
    <div className="sb-floating-surface" style={popoverStyle} role="listbox" aria-label="File mentions">
      <div style={{
        padding: '6px 10px 4px',
        fontSize: '10px',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.7px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border)',
      }}>
        Files
      </div>
      <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '4px' }}>
        {matches.map((path, i) => {
          const slash = path.lastIndexOf('/')
          const dir = slash === -1 ? '' : path.slice(0, slash)
          const base = slash === -1 ? path : path.slice(slash + 1)
          const selected = i === activeIndex
          return (
            <button
              key={path}
              type="button"
              ref={(el) => { itemRefs.current[i] = el }}
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(path)
              }}
              onMouseEnter={() => onActiveIndexChange(i)}
              role="option"
              aria-selected={selected}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '8px',
                width: '100%',
                padding: '5px 10px',
                borderRadius: '4px',
                border: 'none',
                background: selected ? 'var(--bg-hover)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
                fontSize: '12.5px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 500,
                color: selected ? 'var(--accent)' : 'var(--text-primary)',
                flexShrink: 0,
              }}>
                {base}
              </span>
              {dir && (
                <span style={{
                  color: 'var(--text-muted)',
                  fontSize: '11px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {dir}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div style={{
        padding: '5px 10px',
        borderTop: '1px solid var(--border)',
        fontSize: '10px',
        color: 'var(--text-muted)',
        display: 'flex',
        gap: '10px',
        justifyContent: 'space-between',
      }}>
        <span>
          <kbd style={kbdStyle}>↑</kbd>
          <kbd style={kbdStyle}>↓</kbd>
          navigate · <kbd style={kbdStyle}>Enter</kbd> insert
        </span>
        <span>
          <kbd style={kbdStyle} onClick={onDismiss}>Esc</kbd> dismiss
        </span>
      </div>
    </div>
  )
}

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  boxShadow: '0 6px 24px rgba(0, 0, 0, 0.24)',
  zIndex: 50,
  maxWidth: '520px',
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  padding: '0 4px',
  marginRight: '3px',
  borderRadius: '3px',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
}
