/**
 * Inline file-path pill rendered in agent messages and chat-input drafts.
 *
 * Two render contexts share this component:
 *   1. Post-processed `<code>` in MessageBubble that resolves to a real
 *      repo file → click opens the FileViewerPane scrolled to the line
 *      range.
 *   2. Selection-to-pill from the file viewer / terminal — same chip, but
 *      inserted inline into the chat input draft (handled by the draft
 *      store; the chip itself is identical).
 */
import { memo } from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import type { FilePathRef } from '@shared/filePathRef'

interface FileChipProps {
  ref_: FilePathRef
  /** Display text override; defaults to formatted ref. */
  label?: string
  /** Optional click handler override; defaults to opening the viewer. */
  onClick?: () => void
  /** Compact look (no leading icon), used in tight spaces. */
  compact?: boolean
}

export const FileChip = memo(function FileChip({ ref_, label, onClick, compact }: FileChipProps) {
  const openInViewer = useLayoutStore((s) => s.openInViewer)
  const display = label ?? formatLabel(ref_)
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (onClick) {
      onClick()
      return
    }
    const range =
      ref_.startLine != null
        ? { start: ref_.startLine, end: ref_.endLine ?? ref_.startLine }
        : null
    openInViewer(ref_.path, range)
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className="sb-file-chip"
      title={formatLabel(ref_)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: compact ? '0 6px' : '1px 8px',
        margin: '0 1px',
        fontFamily: 'var(--font-mono)',
        fontSize: '11.5px',
        lineHeight: 1.5,
        color: 'var(--text-primary)',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        borderRadius: '999px',
        cursor: 'pointer',
        verticalAlign: 'baseline',
      }}
    >
      {!compact && (
        <span aria-hidden style={{ opacity: 0.65, fontSize: '10px' }}>📄</span>
      )}
      <span>{display}</span>
    </button>
  )
})

function formatLabel(ref_: FilePathRef): string {
  const last = ref_.path.split('/').pop() || ref_.path
  if (ref_.startLine == null) return last
  if (ref_.endLine == null || ref_.endLine === ref_.startLine) {
    return `${last}:${ref_.startLine}`
  }
  return `${last}:${ref_.startLine}-${ref_.endLine}`
}
