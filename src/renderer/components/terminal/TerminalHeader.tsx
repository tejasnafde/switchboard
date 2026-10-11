import { memo } from 'react'
import type { TerminalStatus } from '@shared/types'
import { cn } from '../../lib/utils'
import { Toolbar } from '../ui/toolbar'

interface TerminalHeaderProps {
  label: string
  status: TerminalStatus
  isActive: boolean
  onClose: () => void
  onClick: () => void
}

const statusColors: Record<TerminalStatus, string> = {
  running: 'bg-[var(--success)]',
  exited: 'bg-[var(--text-muted)]',
  error: 'bg-[var(--error)]',
}

export const TerminalHeader = memo(function TerminalHeader({
  label,
  status,
  isActive,
  onClose,
  onClick,
}: TerminalHeaderProps) {
  return (
    <Toolbar
      onClick={onClick}
      className={cn(
        'cursor-pointer gap-[8px] border-b border-[var(--border)] px-[8px] py-[4px] text-[12px] select-none',
        isActive ? 'bg-[var(--bg-tertiary)]' : 'bg-[var(--bg-secondary)]',
      )}
    >
      <span className={cn('size-[6px] shrink-0 rounded-[50%]', statusColors[status])} />

      <span className={cn('flex-1 truncate', isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
        {label}
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="cursor-pointer border-0 bg-transparent px-[2px] py-0 text-[14px] leading-none text-[var(--text-muted)]"
        title="Close terminal"
      >
        ×
      </button>
    </Toolbar>
  )
})
