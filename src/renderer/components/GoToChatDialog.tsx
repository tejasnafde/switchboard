import { useEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { chatSearchSections, titleMatchRange } from '@shared/chat-search'
import { formatRelativeTime } from '@shared/format'
import { formatBinding, matchesBinding } from '@shared/shortcuts'
import { agentShortLabel, type AgentType, type Project } from '@shared/types'
import { useMachineStore } from '../stores/machine-store'
import { createRendererLogger } from '../logger'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { goToChatItems, type ArchivedChatRow, type GoToChatItem } from './go-to-chat-items'

const log = createRendererLogger('go-to-chat')

const AVATARS: Record<AgentType, { initials: string; className: string }> = {
  'claude-code': { initials: 'CL', className: 'bg-[#6c5ce7]' },
  codex: { initials: 'CX', className: 'bg-[#10a37f]' },
  opencode: { initials: 'OC', className: 'bg-[#e17055]' },
  terminal: { initials: 'TM', className: 'bg-[var(--text-muted)]' },
}

interface GoToChatDialogProps {
  open: boolean
  onClose: () => void
  onOpenChat: (item: GoToChatItem, placement: 'select' | 'beside') => void
}

/**
 * Mod+P: jump to any chat of any project by title or project name. The rules
 * (ranking, Recent, the archive word) are `@shared/chat-search`, which the
 * phones' chat-list search boxes use too.
 */
export function GoToChatDialog({ open, onClose, onOpenChat }: GoToChatDialogProps) {
  const remoteProjects = useMachineStore((s) => s.projects)
  const remotes = useMachineStore((s) => s.remotes)
  const [localProjects, setLocalProjects] = useState<Project[]>([])
  const [archived, setArchived] = useState<ArchivedChatRow[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const loadTicket = useRef(0)

  // The sidebar's list lives in its own state, so read the same backend list
  // on every open; a reply for an earlier open is dropped.
  useEffect(() => {
    if (!open) return
    const ticket = ++loadTicket.current
    setQuery('')
    window.api.app.getProjects()
      .then((projects: Project[]) => { if (ticket === loadTicket.current) setLocalProjects(projects ?? []) })
      .catch((err: unknown) => log.warn('getProjects failed', err))
    window.api.app.getArchivedConversations()
      .then((rows: ArchivedChatRow[]) => { if (ticket === loadTicket.current) setArchived(rows ?? []) })
      .catch((err: unknown) => log.warn('getArchivedConversations failed', err))
  }, [open])

  const items = useMemo(
    () => goToChatItems({ localProjects, remoteProjects, archived }),
    [localProjects, remoteProjects, archived],
  )
  const sections = useMemo(() => chatSearchSections(items, query), [items, query])
  const shown = sections.flatMap((s) => s.items)

  const machineName = (machineId: string) =>
    machineId === 'local' ? null : remotes.find((m) => m.id === machineId)?.name ?? machineId

  const pick = (item: GoToChatItem | undefined, placement: 'select' | 'beside') => {
    if (!item) return
    onClose()
    onOpenChat(item, placement)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && matchesBinding(e, 'Mod+Enter')) {
      e.preventDefault()
      pick(shown.find((item) => item.key === selected), 'beside')
    }
  }

  const keyHint = 'rounded-[4px] border border-[var(--border)] px-[4px] text-[10.5px] [font-family:var(--font-mono)]'

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        asChild
        aria-describedby={undefined}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
        className="palette-modal-content inset-x-0 top-[20vh] z-[1000] mx-auto flex max-h-[520px] w-[min(620px,92vw)] flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] shadow-[0_16px_48px_rgba(0,0,0,0.3)]"
      >
        <Command label="Go to chat" shouldFilter={false} value={selected} onValueChange={setSelected} onKeyDown={onKeyDown}>
          <DialogTitle className="sr-only">Go to chat</DialogTitle>
          <Command.Input
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder="Go to chat..."
            className="w-full border-0 border-b border-[var(--border)] bg-transparent px-[12px] py-[10px] text-[14px] text-[var(--text-primary)] outline-none"
          />
          <Command.List className="max-h-[440px] overflow-y-auto py-[4px]">
            <Command.Empty className="p-[16px] text-center text-[13px] text-[var(--text-muted)]">
              No chat title or project matches.
            </Command.Empty>
            {sections.map((section) => (
              <Command.Group
                key={section.heading ?? 'matches'}
                heading={section.heading ?? undefined}
                className="[&_[cmdk-group-heading]]:px-[12px] [&_[cmdk-group-heading]]:pb-[2px] [&_[cmdk-group-heading]]:pt-[8px] [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-[600] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-[var(--text-muted)]"
              >
                {section.items.map((item) => (
                  <ChatRow key={item.key} item={item} query={query} machine={machineName(item.machineId)} onSelect={() => pick(item, 'select')} />
                ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className="flex gap-[14px] border-t border-[var(--border)] px-[12px] py-[6px] text-[11px] text-[var(--text-muted)]">
            {query.trim() !== '' && <span>{shown.length === 1 ? '1 chat' : `${shown.length} chats`}</span>}
            <span><span className={keyHint}>{formatBinding('Enter')}</span> open</span>
            <span><span className={keyHint}>{formatBinding('Mod+Enter')}</span> open beside</span>
            <span><span className={keyHint}>{formatBinding('Escape')}</span> close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function ChatRow({ item, query, machine, onSelect }: {
  item: GoToChatItem
  query: string
  machine: string | null
  onSelect: () => void
}) {
  const avatar = AVATARS[item.agent]
  const range = titleMatchRange(item.title, query)
  const meta = [machine, item.projectName, agentShortLabel(item.agent), item.lastActivity ? formatRelativeTime(item.lastActivity) : null]
    .filter(Boolean).join(' · ')
  return (
    <Command.Item
      value={item.key}
      onSelect={onSelect}
      className="cmdk-item flex cursor-pointer items-center gap-[10px] px-[12px] py-[6px] text-[13px] text-[var(--text-primary)]"
    >
      <span className={cn('inline-flex size-[16px] shrink-0 items-center justify-center rounded-full text-[8px] text-white', avatar.className)}>
        {avatar.initials}
      </span>
      <span className="min-w-0 flex-1 truncate font-[500]">
        {range ? (
          <>
            {item.title.slice(0, range[0])}
            <mark className="bg-transparent font-[600] text-[var(--accent)]">{item.title.slice(range[0], range[1])}</mark>
            {item.title.slice(range[1])}
          </>
        ) : item.title}
      </span>
      {item.archived && (
        <span className="shrink-0 rounded-[4px] border border-[var(--border)] px-[4px] text-[10.5px] text-[var(--text-muted)]">archived</span>
      )}
      <span className="shrink-0 whitespace-nowrap text-[11.5px] text-[var(--text-muted)]">{meta}</span>
    </Command.Item>
  )
}
