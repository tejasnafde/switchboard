/**
 * Inline chip for a slash-command / agent skill.
 *
 * Rendered inline in sent user-message bubbles when the body began with
 * `/<cmd>` and the cmd is in the session's known skill set. Confirms
 * post-send that the slash was understood as a real command rather than
 * literal text.
 *
 * Visually distinct from `PillChipVisual` (file/terminal/chat-message
 * context pills): green-tinted dot + monospace label so the user can tell
 * "I invoked a skill" apart from "I attached context".
 */
import type { CSSProperties } from 'react'

interface SkillChipProps {
  name: string
}

const SKILL_TINT = '#2ea043'

const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  padding: '0 8px',
  margin: '0 2px',
  borderRadius: '12px',
  background: 'rgba(46, 160, 67, 0.10)',
  border: '1px solid rgba(46, 160, 67, 0.45)',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  // `middle` aligns the chip's vertical center with the surrounding
  // text's x-height midline. `baseline` looked floaty because the
  // chip's content is centered inside the box (alignItems: center) so
  // the box's baseline is the bottom of its content, not the text's.
  verticalAlign: 'middle',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  color: 'var(--text-primary)',
}

export function SkillChip({ name }: SkillChipProps) {
  return (
    <span title={`/${name}`} style={CHIP_STYLE}>
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
    </span>
  )
}
