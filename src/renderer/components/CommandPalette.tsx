import { useMemo } from 'react'
import { Command } from 'cmdk'
import { useLayoutStore } from '../stores/layout-store'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { useThemeStore, type ThemeName } from '../stores/theme-store'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onOpenSettings: () => void
  onOpenSearch?: () => void
  onOpenSessionPicker?: () => void
  onOpenQuickPrompt?: () => void
  onContextBridge?: () => void
  onNewChat?: (projectPath: string) => void
}

/**
 * Command definition used by the palette registry.
 * `run` fires the action; the palette handles closing itself.
 */
interface Cmd {
  id: string
  group: 'Navigation' | 'Chat' | 'Terminal' | 'Theme' | 'Sessions'
  label: string
  shortcut?: string
  /** Hidden unless this predicate returns true (e.g. dual-chat toggle only when >1 session) */
  available?: () => boolean
  run: () => void
}

/**
 * Single source of truth for palette commands.
 *
 * Adding a new shortcut? Add it here — the palette will surface it
 * automatically. Don't add inline items; this registry also feeds into
 * the keyboard shortcuts section of Settings in the future.
 */
function buildCommands(opts: {
  onClose: () => void
  onOpenSettings: () => void
  onOpenSearch?: () => void
  onOpenSessionPicker?: () => void
  onOpenQuickPrompt?: () => void
  onContextBridge?: () => void
  onNewChat?: (projectPath: string) => void
}): Cmd[] {
  const { onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker } = opts

  const layout = () => useLayoutStore.getState()
  const agents = () => useAgentStore.getState()
  const terms = () => useTerminalStore.getState()

  const withActiveSession = (fn: (sid: string) => void) => () => {
    const sid = agents().activeSessionId
    if (sid) fn(sid)
    onClose()
  }

  return [
    // ── Navigation ───────────────────────────────────────────────
    { id: 'nav.toggle-sidebar', group: 'Navigation', label: 'Toggle Sidebar', shortcut: '⌘B',
      run: () => { layout().toggleSidebar(); onClose() } },
    { id: 'nav.toggle-terminal', group: 'Navigation', label: 'Toggle Terminal', shortcut: '⌘J',
      run: () => { layout().toggleTerminal(); onClose() } },
    { id: 'nav.open-settings', group: 'Navigation', label: 'Open Settings', shortcut: '⌘,',
      run: () => { onOpenSettings(); onClose() } },
    { id: 'nav.search', group: 'Navigation', label: 'Search across chats', shortcut: '⌘⇧F',
      available: () => !!onOpenSearch,
      run: () => { onOpenSearch?.(); onClose() } },
    { id: 'nav.dual-chat', group: 'Navigation', label: 'Open second chat panel (dual-chat)', shortcut: '⌘⇧\\',
      available: () => !!onOpenSessionPicker,
      run: () => {
        const l = layout()
        if (l.dualChat) { l.closeRightPanel(); onClose() }
        else { onOpenSessionPicker?.(); onClose() }
      } },
    { id: 'nav.quick-prompt', group: 'Navigation', label: 'Quick prompt (context-aware one-shot)', shortcut: '⌘K',
      available: () => !!opts.onOpenQuickPrompt,
      run: () => { opts.onOpenQuickPrompt?.(); onClose() } },
    { id: 'nav.context-bridge', group: 'Navigation', label: 'Send terminal selection to chat', shortcut: '⌘L',
      available: () => !!opts.onContextBridge,
      run: () => { opts.onContextBridge?.(); onClose() } },

    // ── Chat ─────────────────────────────────────────────────────
    { id: 'chat.interrupt', group: 'Chat', label: 'Stop current turn', shortcut: '⌘⌫',
      available: () => {
        const sid = agents().activeSessionId
        const s = sid ? agents().sessions.find((x) => x.id === sid) : null
        return !!s && (s.status === 'running' || s.status === 'thinking')
      },
      run: withActiveSession((sid) => { window.api.provider?.interrupt?.(sid).catch(() => {}) }) },
    { id: 'chat.clear', group: 'Chat', label: 'Clear all messages in active session',
      run: withActiveSession((sid) => { agents().clearMessages(sid) }) },
    { id: 'chat.archive', group: 'Chat', label: 'Archive active session',
      run: withActiveSession((sid) => {
        const s = agents().sessions.find((x) => x.id === sid)
        window.api.app.archiveConversation(sid, s?.projectPath, s?.title).catch(() => {})
        agents().removeSession(sid)
      }) },
    { id: 'chat.plan-mode', group: 'Chat', label: 'Runtime mode: Plan (no execution)',
      run: withActiveSession((sid) => { agents().setRuntimeMode(sid, 'plan') }) },
    { id: 'chat.sandbox-mode', group: 'Chat', label: 'Runtime mode: Sandbox (ask every tool)',
      run: withActiveSession((sid) => { agents().setRuntimeMode(sid, 'sandbox') }) },
    { id: 'chat.accept-edits', group: 'Chat', label: 'Runtime mode: Accept Edits',
      run: withActiveSession((sid) => { agents().setRuntimeMode(sid, 'accept-edits') }) },
    { id: 'chat.full-access', group: 'Chat', label: 'Runtime mode: Full Access',
      run: withActiveSession((sid) => { agents().setRuntimeMode(sid, 'full-access') }) },

    // ── Terminal ─────────────────────────────────────────────────
    { id: 'term.new-tab', group: 'Terminal', label: 'New Terminal Tab', shortcut: '⌘\\',
      run: withActiveSession((sid) => {
        const ids = terms().getAllPaneIds(sid)
        const cwd = agents().sessions.find((s) => s.id === sid)?.projectPath
        terms().addPaneToActiveWindow(sid, { label: `Terminal ${ids.length + 1}`, cwd })
      }) },
    { id: 'term.new-window-right', group: 'Terminal', label: 'New Terminal Window (right)', shortcut: '⌘T',
      run: withActiveSession((sid) => {
        const ids = terms().getAllWindowIds(sid)
        const cwd = agents().sessions.find((s) => s.id === sid)?.projectPath
        const label = `Terminal ${ids.length + 1}`
        if (ids.length === 0) terms().addWindow(sid, { label, cwd })
        else terms().splitActiveWindow(sid, 'row', { label, cwd })
      }) },
    { id: 'term.new-window-below', group: 'Terminal', label: 'New Terminal Window (below)', shortcut: '⌘⇧T',
      run: withActiveSession((sid) => {
        const ids = terms().getAllWindowIds(sid)
        const cwd = agents().sessions.find((s) => s.id === sid)?.projectPath
        const label = `Terminal ${ids.length + 1}`
        if (ids.length === 0) terms().addWindow(sid, { label, cwd })
        else terms().splitActiveWindow(sid, 'column', { label, cwd })
      }) },
    { id: 'term.cycle-next', group: 'Terminal', label: 'Next tab in active window', shortcut: '⌘⇧]',
      run: withActiveSession((sid) => { terms().cyclePane(sid, 'next') }) },
    { id: 'term.cycle-prev', group: 'Terminal', label: 'Previous tab in active window', shortcut: '⌘⇧[',
      run: withActiveSession((sid) => { terms().cyclePane(sid, 'prev') }) },
  ]
}

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
  onOpenSearch,
  onOpenSessionPicker,
  onOpenQuickPrompt,
  onContextBridge,
}: CommandPaletteProps) {
  const { setTheme } = useThemeStore()
  const sessions = useAgentStore((s) => s.sessions)
  const setActiveSession = useAgentStore((s) => s.setActiveSession)

  const commands = useMemo(
    () => buildCommands({ onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker, onOpenQuickPrompt, onContextBridge }),
    [onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker, onOpenQuickPrompt, onContextBridge],
  )

  if (!open) return null

  const visibleCommands = commands.filter((c) => (c.available ? c.available() : true))

  // Group commands for display
  const groups: Record<string, Cmd[]> = {}
  for (const c of visibleCommands) {
    groups[c.group] = groups[c.group] ?? []
    groups[c.group].push(c)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '20vh',
        background: 'rgba(0, 0, 0, 0.4)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <Command
        label="Command Palette"
        className="palette-modal-content"
        style={{
          width: '540px',
          maxHeight: '520px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.3)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Command.Input
          autoFocus
          placeholder="Type a command..."
          style={{
            padding: '12px 16px',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: '14px',
            outline: 'none',
            width: '100%',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />
        <Command.List
          style={{
            overflowY: 'auto',
            padding: '6px',
            maxHeight: '440px',
          }}
        >
          <Command.Empty style={{
            padding: '16px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '13px',
          }}>
            No results found.
          </Command.Empty>

          {Object.entries(groups).map(([group, items]) => (
            <Command.Group
              key={group}
              heading={group}
              style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '4px 8px', fontWeight: 600 }}
            >
              {items.map((c) => (
                <PaletteItem key={c.id} onSelect={c.run} shortcut={c.shortcut}>
                  {c.label}
                </PaletteItem>
              ))}
            </Command.Group>
          ))}

          {/* Theme is dynamic (current theme highlighted) so keep inline */}
          <Command.Group
            heading="Theme"
            style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '4px 8px', fontWeight: 600 }}
          >
            {(['dark', 'light', 'translucent'] as ThemeName[]).map((t) => (
              <PaletteItem
                key={t}
                onSelect={() => { setTheme(t); onClose() }}
              >
                Theme: {t.charAt(0).toUpperCase() + t.slice(1)}
              </PaletteItem>
            ))}
          </Command.Group>

          {sessions.length > 0 && (
            <Command.Group
              heading="Sessions"
              style={{ fontSize: '10px', color: 'var(--text-muted)', padding: '4px 8px', fontWeight: 600 }}
            >
              {sessions.map((s) => (
                <PaletteItem
                  key={s.id}
                  onSelect={() => { setActiveSession(s.id); onClose() }}
                >
                  Switch to: {s.title ?? s.projectPath?.split('/').pop() ?? s.id.slice(0, 12)}
                </PaletteItem>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  )
}

function PaletteItem({
  children,
  onSelect,
  shortcut,
}: {
  children: React.ReactNode
  onSelect: () => void
  shortcut?: string
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '8px 12px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '13px',
        color: 'var(--text-primary)',
        gap: '8px',
      }}
      className="cmdk-item"
    >
      <span style={{ flex: 1 }}>{children}</span>
      {shortcut && (
        <span style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--bg-tertiary)',
          padding: '2px 6px',
          borderRadius: '3px',
          border: '1px solid var(--border)',
        }}>
          {shortcut}
        </span>
      )}
    </Command.Item>
  )
}
