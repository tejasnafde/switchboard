import { agentMark, agentMarkInitials, type AgentMarkData } from '@shared/agent-marks'
import { agentShortLabel, isAgentType } from '@shared/types'
import { cn } from '../../lib/utils'

/** The three sizes the app draws a mark at: a list row, a chip, a tab. */
export type AgentMarkSize = 12 | 14 | 16

interface AgentMarkProps {
  /** The agent, in either spelling (`claude-code` or the wire's `claude`). */
  agent: string | null | undefined
  size?: AgentMarkSize
  /**
   * Names the agent for a screen reader. Leave it unset when the name is
   * already in text beside the mark, and the mark is hidden instead.
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
  if (!mark) return <MarkInitials agent={agent} size={size} a11y={a11y} className={className} label={label} />
  return (
    <svg
      {...a11y}
      viewBox={mark.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      className={cn('inline-block shrink-0', className)}
    >
      {paths(mark)}
    </svg>
  )
}

function paths(mark: AgentMarkData) {
  return mark.paths.map((d) => <path key={d} d={d} fillRule={mark.fillRule} clipRule={mark.fillRule} />)
}

function MarkInitials({
  agent,
  size,
  label,
  a11y,
  className,
}: {
  agent: string | null | undefined
  size: AgentMarkSize
  label: string | undefined
  a11y: Record<string, unknown>
  className: string | undefined
}) {
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
