import { useMemo, useRef } from 'react'
import { Command } from 'cmdk'
import { useLayoutStore } from '../stores/layout-store'
import { useAgentStore } from '../stores/agent-store'
import { useTerminalStore } from '../stores/terminal-store'
import { sessionExecutionRootPath } from '../services/executionRoot'
import { useThemeStore, type ThemeName } from '../stores/theme-store'
import { createRendererLogger } from '../logger'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const log = createRendererLogger('command-palette')

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

export function commandTargetSessionId(state: {
  primarySessionId: string | null
  secondarySessionId: string | null
  focusedChatSlot: 'primary' | 'secondary'
}): string | null {
  return state.focusedChatSlot === 'secondary'
    ? state.secondarySessionId ?? state.primarySessionId
    : state.primarySessionId
}

/**
 * Single source of truth for palette commands.
 *
 * Adding a new shortcut? Add it here - the palette will surface it
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
}): Cmd[] {
  const { onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker } = opts

  const layout = () => useLayoutStore.getState()
  const agents = () => useAgentStore.getState()
  const terms = () => useTerminalStore.getState()

  const withFocusedSession = (fn: (sid: string) => void) => () => {
    const sid = commandTargetSessionId(layout())
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
        if (l.secondarySessionId) { l.closeChatSlot('secondary'); onClose() }
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
        const sid = commandTargetSessionId(layout())
        const s = sid ? agents().sessions.find((x) => x.id === sid) : null
        return !!s && (s.status === 'running' || s.status === 'thinking')
      },
      run: withFocusedSession((sid) => {
        window.api.provider?.interrupt?.(sid).catch((err) => {
          log.debug(`command-palette interrupt failed for ${sid}`, err)
        })
      }) },
    { id: 'chat.clear', group: 'Chat', label: 'Clear all messages in active session',
      run: withFocusedSession((sid) => { agents().clearMessages(sid) }) },
    { id: 'chat.archive', group: 'Chat', label: 'Archive active session',
      run: withFocusedSession((sid) => {
        const s = agents().sessions.find((x) => x.id === sid)
        window.api.app.archiveConversation(sid, s?.projectPath, s?.title).catch((err) => {
          log.warn(`archiveConversation failed for ${sid}`, err)
        })
        agents().removeSession(sid)
      }) },
    { id: 'chat.plan-mode', group: 'Chat', label: 'Runtime mode: Plan (no execution)',
      run: withFocusedSession((sid) => { agents().setRuntimeMode(sid, 'plan') }) },
    { id: 'chat.sandbox-mode', group: 'Chat', label: 'Runtime mode: Sandbox (ask every tool)',
      run: withFocusedSession((sid) => { agents().setRuntimeMode(sid, 'sandbox') }) },
    { id: 'chat.accept-edits', group: 'Chat', label: 'Runtime mode: Accept Edits',
      run: withFocusedSession((sid) => { agents().setRuntimeMode(sid, 'accept-edits') }) },
    { id: 'chat.auto-mode', group: 'Chat', label: 'Runtime mode: Auto (agent approves routine actions)',
      run: withFocusedSession((sid) => { agents().setRuntimeMode(sid, 'auto') }) },
    { id: 'chat.full-access', group: 'Chat', label: 'Runtime mode: Full Access',
      run: withFocusedSession((sid) => { agents().setRuntimeMode(sid, 'full-access') }) },

    // ── Terminal ─────────────────────────────────────────────────
    { id: 'term.new-tab', group: 'Terminal', label: 'New Terminal Tab', shortcut: '⌘\\',
      run: withFocusedSession((sid) => {
        const ids = terms().getAllPaneIds(sid)
        const cwd = sessionExecutionRootPath(sid)
        terms().addPaneToActiveWindow(sid, { label: `Terminal ${ids.length + 1}`, cwd })
      }) },
    { id: 'term.new-window-right', group: 'Terminal', label: 'New Terminal Window (right)', shortcut: '⌘T',
      run: withFocusedSession((sid) => {
        const ids = terms().getAllWindowIds(sid)
        const cwd = sessionExecutionRootPath(sid)
        const label = `Terminal ${ids.length + 1}`
        if (ids.length === 0) terms().addWindow(sid, { label, cwd })
        else terms().splitActiveWindow(sid, 'row', { label, cwd })
      }) },
    { id: 'term.new-window-below', group: 'Terminal', label: 'New Terminal Window (below)', shortcut: '⌘⇧T',
      run: withFocusedSession((sid) => {
        const ids = terms().getAllWindowIds(sid)
        const cwd = sessionExecutionRootPath(sid)
        const label = `Terminal ${ids.length + 1}`
        if (ids.length === 0) terms().addWindow(sid, { label, cwd })
        else terms().splitActiveWindow(sid, 'column', { label, cwd })
      }) },
    { id: 'term.cycle-next', group: 'Terminal', label: 'Next tab in active window', shortcut: '⌘⇧]',
      run: withFocusedSession((sid) => { terms().cyclePane(sid, 'next') }) },
    { id: 'term.cycle-prev', group: 'Terminal', label: 'Previous tab in active window', shortcut: '⌘⇧[',
      run: withFocusedSession((sid) => { terms().cyclePane(sid, 'prev') }) },
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
  const selectChatSession = useLayoutStore((s) => s.selectChatSession)

  const commands = useMemo(
    () => buildCommands({ onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker, onOpenQuickPrompt, onContextBridge }),
    [onClose, onOpenSettings, onOpenSearch, onOpenSessionPicker, onOpenQuickPrompt, onContextBridge],
  )

  const visibleCommands = commands.filter((c) => (c.available ? c.available() : true))

  // Group commands for display
  const groups: Record<string, Cmd[]> = {}
  for (const c of visibleCommands) {
    groups[c.group] = groups[c.group] ?? []
    groups[c.group].push(c)
  }

  const inputRef = useRef<HTMLInputElement>(null)
  // Dismissing the palette returns focus to where it was. Running a command
  // does not: the command decides, and one that opens Settings or a picker
  // must not have focus pulled back to the composer behind it.
  const ranCommand = useRef(false)
  const runCommand = (fn: () => void) => () => {
    ranCommand.current = true
    fn()
  }

  const groupHeadingClass = 'px-[8px] py-[4px] text-[10px] font-[600] text-[var(--text-muted)]'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        asChild
        aria-describedby={undefined}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ranCommand.current = false
          inputRef.current?.focus()
        }}
        onCloseAutoFocus={(e) => { if (ranCommand.current) e.preventDefault() }}
        className="palette-modal-content inset-x-0 top-[20vh] z-[1000] mx-auto flex max-h-[520px] w-[540px] flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_16px_48px_rgba(0,0,0,0.3)]"
      >
        <Command label="Command Palette">
          <DialogTitle className="sr-only">Command Palette</DialogTitle>
          <Command.Input
            ref={inputRef}
            placeholder="Type a command..."
            className="w-full border-0 border-b border-[var(--border)] bg-transparent px-[16px] py-[12px] text-[14px] text-[var(--text-primary)] outline-none"
          />
          <Command.List className="max-h-[440px] overflow-y-auto p-[6px]">
            <Command.Empty className="p-[16px] text-center text-[13px] text-[var(--text-muted)]">
              No results found.
            </Command.Empty>

            {Object.entries(groups).map(([group, items]) => (
              <Command.Group key={group} heading={group} className={groupHeadingClass}>
                {items.map((c) => (
                  <PaletteItem key={c.id} onSelect={runCommand(c.run)} shortcut={c.shortcut}>
                    {c.label}
                  </PaletteItem>
                ))}
              </Command.Group>
            ))}

            {/* Theme is dynamic (current theme highlighted) so keep inline */}
            <Command.Group heading="Theme" className={groupHeadingClass}>
              {(['dark', 'light', 'translucent'] as ThemeName[]).map((t) => (
                <PaletteItem
                  key={t}
                  onSelect={runCommand(() => { setTheme(t); onClose() })}
                >
                  Theme: {t.charAt(0).toUpperCase() + t.slice(1)}
                </PaletteItem>
              ))}
            </Command.Group>

            {sessions.length > 0 && (
              <Command.Group heading="Sessions" className={groupHeadingClass}>
                {sessions.map((s) => (
                  <PaletteItem
                    key={s.id}
                    onSelect={runCommand(() => { selectChatSession(s.id); onClose() })}
                  >
                    Switch to: {s.title ?? s.projectPath?.split('/').pop() ?? s.id.slice(0, 12)}
                  </PaletteItem>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
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
      className="cmdk-item flex cursor-pointer items-center gap-[8px] rounded-[6px] px-[12px] py-[8px] text-[13px] text-[var(--text-primary)]"
    >
      <span className="flex-1">{children}</span>
      {shortcut && (
        <span className="rounded-[3px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[6px] py-[2px] text-[11px] [font-family:var(--font-mono)] text-[var(--text-muted)]">
          {shortcut}
        </span>
      )}
    </Command.Item>
  )
}
