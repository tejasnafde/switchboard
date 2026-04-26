import { memo } from 'react'
import type { TerminalStatus } from '@shared/types'

interface TerminalHeaderProps {
  label: string
  status: TerminalStatus
  isActive: boolean
  onClose: () => void
  onClick: () => void
}

const statusColors: Record<TerminalStatus, string> = {
  running: 'var(--success)',
  exited: 'var(--text-muted)',
  error: 'var(--error)',
}

export const TerminalHeader = memo(function TerminalHeader({
  label,
  status,
  isActive,
  onClose,
  onClick,
}: TerminalHeaderProps) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 8px',
        background: isActive ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        userSelect: 'none',
        fontSize: '12px',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: statusColors[status],
          flexShrink: 0,
        }}
      />

      <span
        style={{
          flex: 1,
          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: '0 2px',
          fontSize: '14px',
          lineHeight: 1,
        }}
        title="Close terminal"
      >
        ×
      </button>
    </div>
  )
})
