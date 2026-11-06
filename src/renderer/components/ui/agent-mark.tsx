import { agentMark, agentMarkInitials } from '@shared/agent-marks'
import { agentShortLabel, isAgentType } from '@shared/types'
import { cn } from '../../lib/utils'

interface AgentMarkProps {
  /** The agent, in either spelling (`claude-code` or the wire's `claude`). */
  agent: string | null | undefined
  /** A list row, a chip, a tab. */
  size?: 12 | 14 | 16
  /**
   * Names the agent for a screen reader. Leave it unset where the name is
   * already in text beside the mark: the mark is then hidden instead.
   */
  label?: string
  className?: string
}

/**
 * The agent's own mark, in one colour. It paints `currentColor`, so a row
 * gives it the colour the row is already in: muted in a list, the text colour
 * when the row is active. An agent with no mark (a local ACP command) draws
 * its initials in the same box, so a list never loses its column.
 */
export function AgentMark({ agent, size = 12, label, className }: AgentMarkProps) {
  const mark = agentMark(agent)
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)
  if (!mark) {
    const name = label ?? (isAgentType(agent) ? agentShortLabel(agent) : (agent ?? ''))
    return (
      <span
        {...a11y}
        style={{ width: size, height: size, fontSize: size <= 12 ? 7 : 8 }}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-[3px] border border-current font-[600] leading-none tracking-[0.02em]',
          className,
        )}
      >
        {agentMarkInitials(name)}
      </span>
    )
  }
  return (
    <svg
      {...a11y}
      viewBox={mark.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      className={cn('inline-block shrink-0', className)}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} fillRule={mark.fillRule} clipRule={mark.fillRule} />
      ))}
    </svg>
  )
}
