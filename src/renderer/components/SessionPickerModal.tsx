import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../stores/agent-store'
import { useMachineStore } from '../stores/machine-store'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

interface PickerSessionIdentity {
  id: string
  type: string
  title?: string
  status: string
  projectPath?: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  machineId?: string
}

export function sessionPickerIdentity(
  session: PickerSessionIdentity,
  machineName?: string,
): { provider: string; title: string; context: string } {
  const provider = session.type === 'codex'
    ? 'Codex'
    : session.type === 'opencode'
      ? 'OpenCode'
      : session.type === 'terminal'
        ? 'Terminal'
        : 'Claude'
  const folder = (session.worktreePath ?? session.projectPath)?.split('/').filter(Boolean).pop()
  const machine = session.machineId && session.machineId !== 'local'
    ? machineName ?? session.machineId
    : 'Local'
  return {
    provider,
    title: session.title ?? session.id.slice(0, 8),
    context: [folder, session.worktreeBranch, machine, session.status].filter(Boolean).join(' · '),
  }
}

interface SessionPickerModalProps {
  open: boolean
  onClose: () => void
  onPick: (sessionId: string) => void
  /** Session IDs to exclude from the picker (e.g. the currently-active one). */
  excludeIds?: string[]
  title?: string
}

/**
 * Small picker modal for selecting a session to open in a side-by-side
 * chat panel. Used by the ⌘⇧\ keybinding and the "open right panel" flow.
 *
 * Keyboard-first: ↑/↓ to navigate, Enter to pick, Esc to dismiss.
 */
export function SessionPickerModal({
  open,
  onClose,
  onPick,
  excludeIds = [],
  title = 'Open a loaded chat beside this one',
}: SessionPickerModalProps) {
  const sessions = useAgentStore((s) => s.sessions)
  const remotes = useMachineStore((s) => s.remotes)
  const [activeIdx, setActiveIdx] = useState(0)

  const candidates = useMemo(
    () => sessions.filter((s) => s.type !== 'terminal' && !excludeIds.includes(s.id)),
    [sessions, excludeIds],
  )

  useEffect(() => {
    if (open) setActiveIdx(0)
  }, [open])

  // Escape is the dialog's; focus stays inside it, so the list keys can live
  // on the content instead of a window listener.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, candidates.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = candidates[activeIdx]
      if (pick) {
        onPick(pick.id)
        onClose()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        overlayClassName="z-[1200]"
        className="sb-floating-surface inset-x-0 top-[18vh] z-[1200] mx-auto flex max-h-[60vh] w-[min(520px,92vw)] flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)] shadow-[0_10px_40px_rgba(0,0,0,0.4)]!"
      >
        <DialogTitle className="border-b border-[var(--border)] px-[14px] py-[10px] text-[11px] font-[600] uppercase tracking-[0.8px] text-[var(--text-muted)]">
          {title}
        </DialogTitle>
        {candidates.length === 0 ? (
          <div className="p-[16px] text-center text-[12px] text-[var(--text-muted)]">
            No other loaded chats are available. Open a chat from the sidebar, then choose Open beside.
          </div>
        ) : (
          <div className="overflow-y-auto py-[4px]">
            {candidates.map((s, i) => {
              const selected = i === activeIdx
              const identity = sessionPickerIdentity(
                s,
                remotes.find((machine) => machine.id === s.machineId)?.name,
              )
              return (
                <button
                  key={s.id}
                  onClick={() => { onPick(s.id); onClose() }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    'flex w-full cursor-pointer items-start gap-[8px] border-0 px-[14px] py-[8px] text-left text-[var(--text-primary)]',
                    selected ? 'bg-[var(--bg-hover)]' : 'bg-transparent',
                  )}
                >
                  <span className={cn('min-w-[46px] text-[10px] [font-family:var(--font-mono)]', selected ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')}>
                    {identity.provider}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="truncate text-[13px]">
                      {identity.title}
                    </span>
                    <span className="text-[10px] [font-family:var(--font-mono)] text-[var(--text-muted)]">
                      {identity.context}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div className="flex gap-[10px] border-t border-[var(--border)] px-[14px] py-[6px] text-[10.5px] text-[var(--text-muted)]">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc dismiss</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
