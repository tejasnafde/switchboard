import { useState } from 'react'
import type { ForkLineageMetadata } from '@shared/conversation-fork'
import { openConversationAtAnchor } from '../../services/openConversationAtAnchor'

export function forkResumeLabel(metadata: ForkLineageMetadata): string {
  return metadata.resumeMode === 'native' ? 'Native resume' : 'Transcript handoff'
}

export function ForkLineageBanner({ metadata }: { metadata: ForkLineageMetadata }) {
  const [error, setError] = useState<string | null>(null)
  const detail = metadata.git
    ? `${metadata.git.branch} from ${metadata.git.baseSha.slice(0, 8)}`
    : forkResumeLabel(metadata)

  return (
    <aside
      aria-label="Conversation fork lineage"
      data-testid="fork-lineage-banner"
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
      <span aria-hidden="true">⑂</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        Forked from <strong style={{ color: 'var(--text-secondary)' }}>{metadata.parentTitle}</strong>
        {' · '}{metadata.anchor.preview || 'selected message'}{' · '}{detail}
        {metadata.git?.sourceDirty ? ' · uncommitted changes were not copied' : ''}
      </span>
      <button
        type="button"
        onClick={() => {
          setError(null)
          void openConversationAtAnchor(metadata).catch((cause) => setError(String(cause)))
        }}
        title="Open the parent conversation at the fork point"
        style={{
          marginLeft: 'auto',
          border: 0,
          background: 'none',
          color: 'var(--accent)',
          cursor: 'pointer',
          padding: '5px 0 5px 8px',
          whiteSpace: 'nowrap',
        }}
      >
        Open parent
      </button>
      {error && <span role="alert" title={error}>Parent unavailable</span>}
    </aside>
  )
}
