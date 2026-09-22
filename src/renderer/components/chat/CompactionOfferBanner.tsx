import { formatTokens } from '@shared/format'

/** "Resume with less context" nudge. Rendering only: the decision is
 *  `shouldOfferCompaction` in shared, the action is an ordinary `/compact` turn. */
export function CompactionOfferBanner({
  usedTokens,
  onCompact,
  onDismiss,
}: {
  usedTokens: number
  onCompact: () => void
  onDismiss: () => void
}) {
  return (
    <aside
      aria-label="Resume with less context"
      data-testid="compaction-offer-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        padding: '5px 16px',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Resume with less context</strong>
        {' · '}{formatTokens(usedTokens)} tokens from earlier
      </span>
      <button
        type="button"
        onClick={onCompact}
        title="Send /compact so the agent summarises the earlier conversation"
        style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: '5px 0 5px 8px', whiteSpace: 'nowrap' }}
      >
        Compact
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title="Keep full history"
        aria-label="Keep full history"
        style={{ border: 0, background: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px', fontSize: 14, lineHeight: 1 }}
      >
        ×
      </button>
    </aside>
  )
}
