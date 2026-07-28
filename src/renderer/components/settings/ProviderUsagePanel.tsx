/**
 * Subscription usage for one provider instance, rendered as a full-width line
 * inside the instance card. The card already wraps, so `flexBasis: 100%` gives
 * this its own line with no restructuring; the rows are a grid rather than
 * nested flex so the bars stay column-aligned as the numbers change.
 */

import type { ProviderUsage, UsageOverage, UsageSeverity, UsageWindow } from '@shared/provider-usage'
import { fmtResetsAt, fmtResetsIn } from '@shared/provider-usage'

function severityColor(severity: UsageSeverity): string {
  // Same thresholds and tokens as ContextWindowMeter, so a filling bar means
  // the same thing in Settings as it does in the chat header.
  if (severity === 'critical') return 'var(--error)'
  if (severity === 'warn') return 'var(--warning)'
  return 'var(--text-muted)'
}

function UsageBar({ percent, color }: { percent: number | null; color: string }) {
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <div
      style={{
        height: '4px',
        borderRadius: '2px',
        background: 'var(--border)',
        overflow: 'hidden',
        minWidth: '40px',
      }}
    >
      <div
        style={{
          width: `${width}%`,
          height: '100%',
          background: color,
          transition: 'width 0.3s ease-out',
        }}
      />
    </div>
  )
}

function percentText(percent: number | null): string {
  return percent === null ? '-' : `${Math.round(percent)}%`
}

function WindowRow({ window: win, now }: { window: UsageWindow; now: number }) {
  return (
    <>
      <div style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{win.label}</div>
      <div
        role="progressbar"
        aria-label={win.label}
        aria-valuenow={win.usedPercent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <UsageBar percent={win.usedPercent} color={severityColor(win.severity)} />
      </div>
      <div style={{ display: 'flex', gap: '8px', whiteSpace: 'nowrap', alignItems: 'baseline' }}>
        <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '32px', textAlign: 'right' }}>
          {percentText(win.usedPercent)}
        </span>
        <span
          style={{ color: 'var(--text-muted)' }}
          title={win.resetsAtMs !== null ? fmtResetsAt(win.resetsAtMs) : undefined}
        >
          {fmtResetsIn(win.resetsAtMs, now)}
        </span>
        {win.detail && <span style={{ color: 'var(--text-muted)' }}>{win.detail}</span>}
      </div>
    </>
  )
}

function OverageRow({ overage }: { overage: UsageOverage }) {
  // No bar when the feature is switched off: a full red bar for a disabled
  // credit pool reads as "you are out of quota", which is not what it means.
  return (
    <>
      <div style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{overage.label}</div>
      <div>
        {overage.enabled && overage.usedPercent !== null
          ? <UsageBar percent={overage.usedPercent} color={severityColor(overage.usedPercent >= 100 ? 'critical' : 'ok')} />
          : null}
      </div>
      <div style={{ display: 'flex', gap: '8px', whiteSpace: 'nowrap', alignItems: 'baseline' }}>
        <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: '32px', textAlign: 'right' }}>
          {overage.enabled ? percentText(overage.usedPercent) : 'off'}
        </span>
        {overage.detail && <span style={{ color: 'var(--text-muted)' }}>{overage.detail}</span>}
        {overage.blockedReason && (
          <span style={{ color: 'var(--text-muted)' }}>{overage.blockedReason.replace(/_/g, ' ')}</span>
        )}
      </div>
    </>
  )
}

export function ProviderUsagePanel({
  usage,
  loading,
  onRefresh,
}: {
  usage: ProviderUsage | null
  loading: boolean
  onRefresh: () => void
}) {
  if (!usage && !loading) return null

  const now = Date.now()
  const hasRows = usage !== null && (usage.windows.length > 0 || usage.overage.length > 0)

  return (
    <div
      role="region"
      aria-label="Subscription usage"
      style={{
        flexBasis: '100%',
        width: '100%',
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: '1px solid var(--border)',
        fontSize: '10px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '8px',
          marginBottom: hasRows ? '6px' : 0,
          color: 'var(--text-muted)',
        }}
      >
        <span>
          {loading && !usage
            ? 'Loading usage…'
            : [
                usage?.plan ? `Plan: ${usage.plan}` : null,
                usage?.account,
                usage ? `as of ${new Date(usage.fetchedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : null,
              ].filter(Boolean).join(' · ')}
        </span>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{
            border: 'none',
            background: 'transparent',
            padding: 0,
            fontSize: '10px',
            color: 'var(--text-secondary)',
            cursor: loading ? 'default' : 'pointer',
            textDecoration: 'underline',
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {hasRows && usage && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(96px, 140px) 1fr auto',
            gap: '6px 10px',
            alignItems: 'center',
          }}
        >
          {usage.windows.map((win) => <WindowRow key={win.id} window={win} now={now} />)}
          {usage.overage.length > 0 && usage.windows.length > 0 && (
            <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', marginTop: '2px' }} />
          )}
          {usage.overage.map((o) => <OverageRow key={o.id} overage={o} />)}
        </div>
      )}

      {usage && usage.status !== 'ok' && usage.message && (
        <div
          style={{
            marginTop: hasRows ? '6px' : 0,
            // Only a genuine failure is red. not-applicable / unsupported /
            // expired are informational states, not errors.
            color: usage.status === 'error' ? 'var(--error)' : 'var(--text-muted)',
            wordBreak: 'break-word',
          }}
        >
          {usage.message}
        </div>
      )}

      {usage?.command && (
        <div
          style={{
            marginTop: '6px',
            padding: '5px 7px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'var(--bg-tertiary)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '10px',
            color: 'var(--text-secondary)',
            wordBreak: 'break-all',
            userSelect: 'text',
          }}
        >
          {usage.command}
        </div>
      )}
    </div>
  )
}
