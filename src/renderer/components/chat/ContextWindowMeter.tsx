import { memo } from 'react'

export interface ContextWindowUsage {
  usedTokens: number
  maxTokens: number | null
  totalProcessedTokens?: number
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '?'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/**
 * Circular SVG meter showing context window usage.
 * Modeled after T3 Code's ContextWindowMeter — renders as a small ring
 * with percentage in the center. Hover shows detailed tooltip.
 */
export const ContextWindowMeter = memo(function ContextWindowMeter({
  usage,
}: {
  usage: ContextWindowUsage
}) {
  const percentage = usage.maxTokens
    ? Math.min(100, Math.max(0, (usage.usedTokens / usage.maxTokens) * 100))
    : null

  const radius = 9.75
  const circumference = 2 * Math.PI * radius
  const dashOffset = percentage !== null
    ? circumference - (percentage / 100) * circumference
    : circumference

  // Color based on usage level
  const strokeColor =
    percentage !== null && percentage > 85
      ? 'var(--error)'
      : percentage !== null && percentage > 60
        ? 'var(--warning, #d29922)'
        : 'var(--text-muted)'

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      title={
        percentage !== null
          ? `Context: ${Math.round(percentage)}% — ${formatTokens(usage.usedTokens)}/${formatTokens(usage.maxTokens)} tokens`
          : `${formatTokens(usage.usedTokens)} tokens used`
      }
    >
      <span style={{
        position: 'relative',
        display: 'flex',
        width: '24px',
        height: '24px',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <svg
          viewBox="0 0 24 24"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            transform: 'rotate(-90deg)',
          }}
        >
          {/* Background ring */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke="var(--border)"
            strokeWidth="3"
          />
          {/* Progress ring */}
          <circle
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
          />
        </svg>
        <span style={{
          position: 'relative',
          fontSize: '7px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          lineHeight: 1,
        }}>
          {percentage !== null ? Math.round(percentage) : formatTokens(usage.usedTokens)}
        </span>
      </span>
    </div>
  )
})
