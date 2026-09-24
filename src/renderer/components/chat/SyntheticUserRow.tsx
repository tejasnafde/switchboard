import type { CSSProperties } from 'react'
import type { ChatMessage } from '@shared/types'
import {
  isSyntheticOnlyUserText,
  syntheticPartDetail,
  syntheticPartLabel,
  syntheticPartTone,
  type SyntheticTone,
  type SyntheticUserPart,
} from '@shared/synthetic-message'

const TONE_COLOR: Record<SyntheticTone, string> = {
  ok: 'var(--success)',
  error: 'var(--error)',
  warn: 'var(--warning)',
  muted: 'var(--text-muted)',
}

/**
 * A user-role message nobody typed (see @shared/synthetic-message). Attached
 * images still render as a user bubble, so such a message does not count.
 */
export function isSyntheticOnlyMessage(message: ChatMessage): boolean {
  return message.role === 'user'
    && message.displayBody === undefined
    && !message.images?.length
    && isSyntheticOnlyUserText(message.content)
}

/** Compact, muted row for a provider-generated user-role block. */
export function SyntheticUserRow({ part }: { part: SyntheticUserPart }) {
  const label = syntheticPartLabel(part)
  const detail = syntheticPartDetail(part)
  const dot = (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        flexShrink: 0,
        background: TONE_COLOR[syntheticPartTone(part)],
      }}
    />
  )
  const mono = part.kind === 'command-output'
  const style: CSSProperties = {
    margin: '4px 16px',
    fontSize: 11,
    color: 'var(--text-muted)',
  }
  const line: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: mono ? 'pre-wrap' : 'normal',
    fontFamily: mono ? 'var(--font-mono)' : undefined,
  }
  if (!detail) {
    return <div data-synthetic-kind={part.kind} style={style}><div style={line}>{dot}{label}</div></div>
  }
  return (
    <details data-synthetic-kind={part.kind} style={style}>
      <summary style={{ ...line, cursor: 'pointer', listStyle: 'none' }} title={detail}>{dot}{label}</summary>
      <div style={{ padding: '4px 0 0 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}>
        {detail}
      </div>
    </details>
  )
}
