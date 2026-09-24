import { useLayoutStore } from '../../stores/layout-store'

/**
 * Segmented "Chats / Board" toggle in the title bar. Mirrors ⌘⇧K so the
 * mode swap is discoverable without the keyboard shortcut. Sits inside
 * the drag region but opts out via WebkitAppRegion: 'no-drag' so clicks
 * land on the buttons.
 */
export function ViewToggle(): React.ReactElement {
  const appView = useLayoutStore((s) => s.appView)
  const setAppView = useLayoutStore((s) => s.setAppView)
  const baseBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: '3px 10px',
    fontSize: '11px',
    fontWeight: 500,
    cursor: 'pointer',
    color: 'var(--text-muted)',
    borderRadius: '4px',
    WebkitAppRegion: 'no-drag',
    transition: 'background 0.12s, color 0.12s',
  }
  const activeBtn: React.CSSProperties = {
    ...baseBtn,
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '2px',
        gap: '2px',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      }}
      title="Toggle Chats ↔ Board (⌘⇧K)"
    >
      <button
        type="button"
        style={appView === 'chats' ? activeBtn : baseBtn}
        onClick={() => setAppView('chats')}
      >
        Chats
      </button>
      <button
        type="button"
        style={appView === 'kanban' ? activeBtn : baseBtn}
        onClick={() => setAppView('kanban')}
      >
        Board
      </button>
    </span>
  )
}
