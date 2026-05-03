/**
 * Inline chip for a slash-command / agent skill.
 *
 * Rendered in two surfaces:
 *   - Live in the chat input footer when the current draft starts with a
 *     recognized slash-command pattern (gives users confidence the skill
 *     will fire before they hit Send).
 *   - Inline in sent user-message bubbles when the message body began with
 *     `/<cmd>` — round-trips the same visual so the read-back matches what
 *     the compose surface showed.
 *
 * Visually distinct from `PillChipVisual` (file/terminal/chat-message
 * context pills): teal-tinted dot + monospace label so the user can tell
 * "I invoked a skill" apart from "I attached context".
 */
import type { CSSProperties } from 'react'

interface SkillChipProps {
  name: string
  /** Optional subtitle (description) shown after the name; useful in the input footer. */
  description?: string
  /** Compact variant for the input footer (smaller padding). */
  compact?: boolean
}

const SKILL_TINT = '#2ea043'

export function SkillChip({ name, description, compact }: SkillChipProps) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    padding: compact ? '0 6px' : '1px 8px',
    margin: '0 4px 0 0',
    borderRadius: '12px',
    background: 'rgba(46, 160, 67, 0.10)',
    border: '1px solid rgba(46, 160, 67, 0.45)',
    fontFamily: 'var(--font-mono)',
    fontSize: compact ? '10.5px' : '11px',
    verticalAlign: 'baseline',
    lineHeight: '1.4',
    whiteSpace: 'nowrap',
    color: 'var(--text-primary)',
  }
  return (
    <span title={description ? `/${name} — ${description}` : `/${name}`} style={style}>
      <span
        style={{
          width: 4,
          height: 4,
          borderRadius: '50%',
          background: SKILL_TINT,
          flexShrink: 0,
        }}
      />
      <span style={{ fontWeight: 600 }}>/{name}</span>
      {description && (
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          · {description}
        </span>
      )}
    </span>
  )
}
