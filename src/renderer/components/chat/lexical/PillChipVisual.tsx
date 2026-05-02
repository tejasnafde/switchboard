/**
 * Presentational pill chip — pure visual, no Lexical / store deps.
 * Used by both `PillNode` (live editor decorator) and `MessagePillChip`
 * (read-only chip in sent message bubbles), so the chip never visually
 * drifts between compose and sent views.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { DraftPillKind } from '../../../stores/draft-store'

export function tintForKind(kind: DraftPillKind): string {
  if (kind === 'file') return 'var(--accent, #58a6ff)'
  if (kind === 'terminal') return '#d29922'
  return '#8957e5'
}

interface PillChipVisualProps {
  label: string
  kind: DraftPillKind
  /** Editor variant disables text selection; bubble variant allows copy. */
  selectable?: boolean
  /** Optional trailing slot — used by the editor for the × remove button. */
  trailing?: ReactNode
  /** Forwarded to the root span (data-pill-chip, data-pill-id, contentEditable). */
  rootProps?: Record<string, string | boolean | undefined>
}

const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '1px 8px',
  margin: '0 2px',
  borderRadius: '12px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border-strong, var(--border))',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  verticalAlign: 'baseline',
  lineHeight: '1.4',
  whiteSpace: 'nowrap',
  maxWidth: '260px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export function PillChipVisual({ label, kind, selectable = true, trailing, rootProps }: PillChipVisualProps) {
  const tint = tintForKind(kind)
  return (
    <span
      title={label}
      {...rootProps}
      style={{ ...CHIP_STYLE, userSelect: selectable ? 'text' : 'none' }}
    >
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: tint, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {trailing}
    </span>
  )
}
