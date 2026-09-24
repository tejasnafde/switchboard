import { useEffect } from 'react'
import { SLASH_COMMANDS } from './slash-commands'

export function SlashHelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '520px',
          maxWidth: '100%',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span>Slash Commands</span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '6px 0' }}>
          {SLASH_COMMANDS.map((cmd) => (
            <div key={cmd.name} style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '12px',
              padding: '7px 14px',
              fontSize: '12.5px',
            }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: 'var(--accent)',
                minWidth: '80px',
              }}>
                /{cmd.name}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {cmd.description}
              </span>
            </div>
          ))}
        </div>
        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          Type <kbd style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            padding: '0 4px',
            background: 'var(--bg-tertiary)',
            borderRadius: '3px',
          }}>/</kbd> at the start of a line to open the inline menu.
        </div>
      </div>
    </div>
  )
}
