/**
 * Inline chip for a slash-command / agent skill.
 *
 * Rendered inline in sent user-message bubbles when the body began with
 * `/<cmd>` and the cmd is in the session's known skill set. Confirms
 * post-send that the slash was understood as a real command rather than
 * literal text.
 *
 * Same frame as `PillChipVisual`; the green tint and the dot tell
 * "I invoked a skill" apart from "I attached context".
 */
import type { CSSProperties } from 'react'
import { INLINE_CHIP_CLASS } from './lexical/PillChipVisual'

const TINT_STYLE = { '--chip-tint': 'var(--chip-tint-skill)' } as CSSProperties

export function SkillChip({ name }: { name: string }) {
  return (
    <span title={`/${name}`} className={`${INLINE_CHIP_CLASS} px-[5px]`} style={TINT_STYLE}>
      <span aria-hidden className="h-[4px] w-[4px] shrink-0 rounded-full bg-[var(--chip-tint)]" />
      <span className="self-baseline font-medium">/{name}</span>
    </span>
  )
}
