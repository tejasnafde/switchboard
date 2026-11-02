/**
 * The chat header's Details popover: machine, branch, linked PR, working-tree
 * changes, an Open in editor action, and the account's usage limits next to
 * the chat's context use. Everything is read when it opens; the rows are
 * built in chat-details-model.ts.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { contextPercent } from '@shared/format'
import { shortcutLabel } from '@shared/shortcuts'
import type { LeftTone } from '@shared/usage-left'
import { cn } from '../../lib/utils'
import { createRendererLogger } from '../../logger'
import { useLayoutStore } from '../../stores/layout-store'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import { useReviewStore } from '../../stores/review-store'
import { useChatLinks } from '../reviews/LinkedPrControl'
import { linkedPrRow } from '../reviews/linked-pr-picker'
import { MenuItem, MenuSeparator } from '../ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  branchValue,
  changesValue,
  editorLabel,
  machineValue,
  prValue,
  usageBars,
  type BranchRead,
  type DetailsValue,
  type DiffRead,
  type UsageBar,
} from './chat-details-model'

const log = createRendererLogger('chat:details')

const TOGGLE_EVENT = 'sb-chat-details-toggle'

/** Opens or closes the Details popover of the panel showing `sessionId` (the Cmd+Shift+B shortcut). */
export function toggleChatDetails(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: { sessionId } }))
}

export interface ChatDetailsProps {
  sessionId: string
  machineId: string | undefined
  machineName: string | undefined
  machineTransport: 'ssh' | 'gcloud-iap' | undefined
  /** The agent's working folder: the worktree, else the project. */
  cwd: string | null
  /** The provider account whose usage limits the bars show. */
  instanceId: string
  contextUsage: { usedTokens: number; maxTokens: number } | undefined
}

const FILL: Record<LeftTone, string> = {
  neutral: 'bg-[var(--text-muted)]',
  warning: 'bg-[var(--warning)]',
  error: 'bg-[var(--error)]',
}

const LEFT_TEXT: Record<LeftTone, string> = {
  neutral: 'text-[var(--text-secondary)]',
  warning: 'text-[var(--text-warning)]',
  error: 'text-[var(--text-error)]',
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-[8px] rounded-[5px] px-[8px] py-[5px]">
      <span className="w-[60px] shrink-0 text-[11px] font-[500] text-[var(--text-muted)]">{label}</span>
      <div className="min-w-0 flex-1 text-[12px] tabular-nums text-[var(--text-primary)]">{children}</div>
    </div>
  )
}

function Value({ value }: { value: DetailsValue }) {
  return <div className={cn('truncate', value.muted && 'text-[var(--text-muted)]')}>{value.text}</div>
}

function Bar({ bar }: { bar: UsageBar }) {
  return (
    <div className="px-[8px] py-[5px]">
      <div className="flex justify-between text-[12px] tabular-nums">
        <span className="text-[var(--text-primary)]">{bar.label}</span>
        {bar.left === null ? (
          <span className="text-[var(--text-muted)]">{bar.pending ? '…' : 'Unavailable'}</span>
        ) : (
          <span className={LEFT_TEXT[bar.tone]}>{bar.left}% left</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={`${bar.label} used`}
        aria-valuenow={bar.used ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-[5px] h-[4px] overflow-hidden rounded-[2px] bg-[var(--bg-tertiary)]"
      >
        {bar.used !== null && (
          <div className={cn('h-full rounded-[2px]', FILL[bar.tone])} style={{ width: `${bar.used}%` }} />
        )}
      </div>
    </div>
  )
}

/** No folder, or a read that threw: the rows show None. */
const UNREAD = { ok: false, error: 'not read' } as const

function useGitReads(cwd: string | null): { branch: BranchRead | undefined; diff: DiffRead | undefined } {
  const [branch, setBranch] = useState<BranchRead>()
  const [diff, setDiff] = useState<DiffRead>()
  useEffect(() => {
    if (!cwd) return
    let live = true
    window.api.git
      .currentBranch(cwd)
      .then((read) => live && setBranch(read))
      .catch((err) => {
        log.warn('reading the branch failed', err)
        if (live) setBranch(UNREAD)
      })
    window.api.git
      .diffStat(cwd)
      .then((read) => live && setDiff(read))
      .catch((err) => {
        log.warn('reading the diff stat failed', err)
        if (live) setDiff(UNREAD)
      })
    return () => {
      live = false
    }
  }, [cwd])
  return cwd ? { branch, diff } : { branch: UNREAD, diff: UNREAD }
}

function DetailsBody({
  sessionId,
  machineId,
  machineName,
  machineTransport,
  cwd,
  instanceId,
  contextUsage,
  onOpenEditor,
}: ChatDetailsProps & { onOpenEditor: () => void }) {
  const links = useChatLinks(sessionId)
  const list = useReviewStore((s) => s.list)
  const pr = useMemo(() => prValue(links.map((link) => linkedPrRow(link, list))), [links, list])
  const { branch, diff } = useGitReads(cwd)
  const changes = changesValue(diff)
  const usage = useProviderInstanceStore((s) => s.usages[instanceId])
  const reading = useProviderInstanceStore((s) => Boolean(s.usageLoading[instanceId]))

  // Unforced: main hands back its cached reading when it is fresh, as for Settings > Accounts.
  useEffect(() => {
    void useProviderInstanceStore.getState().loadUsage(instanceId)
  }, [instanceId])

  const bars = usageBars(
    usage,
    reading,
    contextUsage ? contextPercent(contextUsage.usedTokens, contextUsage.maxTokens) : null,
  )

  return (
    <>
      <Row label="Machine">
        <Value value={{ text: machineValue(machineId, machineName, machineTransport) }} />
      </Row>
      <Row label="Branch">
        <Value value={branchValue(branch)} />
      </Row>
      <Row label="PR">
        {pr ? (
          <>
            <div className="truncate">{pr.title}</div>
            <div className="truncate text-[11px] text-[var(--text-secondary)]">
              {pr.detail.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && ' · '}
                  <span className={cn(part.bad && 'text-[var(--text-error)]')}>{part.text}</span>
                </Fragment>
              ))}
            </div>
          </>
        ) : (
          <Value value={{ text: 'None', muted: true }} />
        )}
      </Row>
      <Row label="Changes">
        {'text' in changes ? (
          <Value value={changes} />
        ) : (
          <div className="flex gap-[8px]">
            <span className="text-[var(--text-success)]">+{changes.added}</span>
            <span className="text-[var(--text-error)]">-{changes.removed}</span>
          </div>
        )}
      </Row>
      <MenuSeparator />
      <MenuItem onClick={onOpenEditor}>{editorLabel(machineId, machineName)}</MenuItem>
      <MenuSeparator />
      <div className="flex flex-col gap-[2px]">
        {bars.map((bar) => (
          <Bar key={bar.label} bar={bar} />
        ))}
      </div>
    </>
  )
}

export function ChatDetailsPopover(props: ChatDetailsProps) {
  const [open, setOpen] = useState(false)
  const { sessionId } = props

  useEffect(() => {
    const onToggle = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail.sessionId === sessionId) setOpen((was) => !was)
    }
    window.addEventListener(TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle)
  }, [sessionId])

  const openEditor = () => {
    setOpen(false)
    const layout = useLayoutStore.getState()
    layout.setRightPaneMode('files')
    if (!layout.terminalVisible) layout.toggleTerminal()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="chat-header-action" title={`Chat details (${shortcutLabel('chat.details')})`}>
          Details
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        aria-label="Chat details"
        className="sb-floating-surface z-[1200] w-[300px] rounded-[8px] border border-[var(--border-strong)] p-[4px] text-[12px] shadow-[0_6px_24px_rgba(0,0,0,0.45)]"
      >
        <DetailsBody {...props} onOpenEditor={openEditor} />
      </PopoverContent>
    </Popover>
  )
}
