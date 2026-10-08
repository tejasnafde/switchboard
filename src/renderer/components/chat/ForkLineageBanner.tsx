import { useState } from 'react'
import type { ForkLineageMetadata } from '@shared/conversation-fork'
import { openConversationAtAnchor } from '../../services/open-conversation-at-anchor'
import { Button } from '../ui/button'

export function forkResumeLabel(metadata: ForkLineageMetadata): string {
  return metadata.resumeMode === 'native' ? 'Native resume' : 'Transcript handoff'
}

export function ForkLineageBanner({ metadata, onSendBack }: {
  metadata: ForkLineageMetadata
  /** Opens the merge-back dialog (send what this fork did back to its parent). */
  onSendBack?: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const detail = metadata.git
    ? `${metadata.git.branch} from ${metadata.git.baseSha.slice(0, 8)}`
    : forkResumeLabel(metadata)

  return (
    <aside
      aria-label="Conversation fork lineage"
      data-testid="fork-lineage-banner"
      className="flex min-h-[32px] shrink-0 items-center gap-[8px] border-b border-[var(--border)] px-[16px] py-[5px] text-[11px] text-[var(--text-muted)]"
    >
      <span aria-hidden="true">⑂</span>
      <span className="min-w-0 truncate">
        Forked from <strong className="text-[var(--text-secondary)]">{metadata.parentTitle}</strong>
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
        className="ml-auto cursor-pointer whitespace-nowrap border-0 bg-transparent py-[5px] pr-0 pl-[8px] text-[var(--accent)]"
      >
        Open parent
      </button>
      {error && <span role="alert" title={error}>Parent unavailable</span>}
      {onSendBack && (
        <Button
          size="sm"
          data-testid="fork-send-back"
          title="Send a summary of this fork's work to the parent chat"
          onClick={onSendBack}
          className="h-6 max-w-[240px] px-2 text-[11px]"
        >
          <span className="truncate">Send back to "{metadata.parentTitle}"</span>
        </Button>
      )}
    </aside>
  )
}
