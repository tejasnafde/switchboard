import { useEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommand } from './slashCommands'
import { filterSlashCommands } from './slashCommands'

interface SlashCommandMenuProps {
  query: string
  onSelect: (command: SlashCommand) => void
  onDismiss: () => void
  /** Called with the currently-highlighted index so ↑↓ keys in the textarea can drive selection */
  onActiveIndexChange?: (idx: number, total: number) => void
  /** Controlled active index (from parent). If omitted the menu manages its own. */
  activeIndex?: number
  /**
   * Full command list to filter against. Defaults to the built-in
   * SLASH_COMMANDS registry. Pass a merged list (built-ins + agent skills)
   * to surface Claude/Codex commands alongside our own.
   */
  commands?: SlashCommand[]
}

/**
 * Inline popover listing matching slash commands.
 *
 * Position: caller absolutely-positions this above/below the textarea. We
 * keep this component layout-agnostic — it only renders the list.
 *
 * Keyboard: the parent textarea forwards ↑↓/Enter/Escape via the
 * `activeIndex` + callbacks. That avoids stealing focus from the textarea
 * (which would break typing).
 */
export function SlashCommandMenu({
  query,
  onSelect,
  onDismiss,
  onActiveIndexChange,
  activeIndex,
  commands: allCommands,
}: SlashCommandMenuProps) {
  const commands = useMemo(
    () => filterSlashCommands(query, allCommands),
    [query, allCommands],
  )
  const [internalIdx, setInternalIdx] = useState(0)
  const idx = activeIndex ?? internalIdx

  useEffect(() => {
    // Reset highlight when the matching set changes
    setInternalIdx(0)
    onActiveIndexChange?.(0, commands.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(() => {
    onActiveIndexChange?.(idx, commands.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, commands.length])

  // Auto-scroll the active row into view when ↑↓ navigation moves past
  // the visible window inside the 240px-tall scroll container.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    const el = itemRefs.current[idx]
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [idx])

  if (commands.length === 0) {
    return (
      <div className="sb-floating-surface" style={popoverStyle}>
        <div style={{
          padding: '8px 12px',
          fontSize: '12px',
          color: 'var(--text-muted)',
          fontStyle: 'italic',
        }}>
          No commands match "/{query}"
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
    <div className="sb-floating-surface" style={popoverStyle} role="listbox" aria-label="Slash commands">
      <div style={{
        padding: '6px 10px 4px',
        fontSize: '10px',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.7px',
        fontWeight: 600,
        borderBottom: '1px solid var(--border)',
      }}>
        Commands
      </div>
      <div style={{ maxHeight: '240px', overflowY: 'auto', padding: '4px' }}>
        {commands.map((cmd, i) => {
          const selected = i === idx
          // Show a small section heading whenever the source changes from
          // the previous row. Keeps built-ins visually distinct from
          // Claude/Codex commands without forcing the user into tabs.
          const prevSource = i > 0 ? (commands[i - 1].source ?? 'switchboard') : null
          const thisSource = cmd.source ?? 'switchboard'
          // Suppress the very first heading — the popover already has a
          // "Commands" header above. Only render headings when the source
          // CHANGES mid-list (e.g. transitioning into Claude Code skills).
          const showHeading = prevSource !== null && prevSource !== thisSource
          return (
            <div key={`${thisSource}:${cmd.name}`}>
              {showHeading && (
                <div style={{
                  padding: '6px 10px 2px',
                  fontSize: '9.5px',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                  fontWeight: 600,
                }}>
                  {sourceLabel(thisSource)}
                </div>
              )}
              <button
                type="button"
                ref={(el) => { itemRefs.current[i] = el }}
                onMouseDown={(e) => {
                  // onMouseDown (not onClick) so we commit BEFORE the textarea
                  // blurs — onClick would race with the input's blur handler.
                  e.preventDefault()
                  onSelect(cmd)
                }}
                onMouseEnter={() => setInternalIdx(i)}
                role="option"
                aria-selected={selected}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '10px',
                  width: '100%',
                  padding: '6px 10px',
                  borderRadius: '4px',
                  border: 'none',
                  background: selected ? 'var(--bg-hover)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                  fontSize: '12.5px',
                }}
              >
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 600,
                  color: selected ? 'var(--accent)' : 'var(--text-primary)',
                  minWidth: '70px',
                }}>
                  /{cmd.name}
                  {cmd.argumentHint && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '4px' }}>
                      {cmd.argumentHint}
                    </span>
                  )}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>
                  {cmd.description}
                </span>
              </button>
            </div>
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
          navigate · <kbd style={kbdStyle}>Enter</kbd> select
        </span>
        <span>
          <kbd style={kbdStyle} onClick={onDismiss}>Esc</kbd> dismiss
        </span>
      </div>
    </div>
  )
}

function sourceLabel(source: string): string {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  return 'Switchboard'
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
