import { useEffect, useState } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import type { DraftChatOptions } from '@shared/new-chat-draft'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:draft-workspace')

const selectStyle = {
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  padding: '3px 6px',
  fontSize: '11px',
  cursor: 'pointer',
  outline: 'none',
} as const

/**
 * Where a draft chat will run, chosen before the first send. Replaces the
 * branch picker while the chat is a draft: a running chat switches its
 * branch, a draft picks the checkout and, for a new worktree, its base.
 */
export function DraftWorkspaceChips({
  sessionId,
  cwd,
  draft,
}: {
  sessionId: string
  cwd: string | null
  draft: DraftChatOptions
}) {
  const setDraftOptions = useAgentStore((s) => s.setDraftOptions)
  const [branches, setBranches] = useState<string[]>([])

  useEffect(() => {
    if (!cwd || draft.checkout !== 'worktree') return
    let cancelled = false
    window.api.git.listRefs(cwd)
      .then((result) => {
        if (cancelled || !result.ok) return
        setBranches(result.refs.filter((r) => !r.isRemote).map((r) => r.name))
      })
      .catch((err: unknown) => log.warn('listRefs failed', err))
    return () => { cancelled = true }
  }, [cwd, draft.checkout])

  return (
    <>
      <select
        aria-label="Workspace"
        data-testid="draft-workspace"
        value={draft.checkout}
        onChange={(e) => setDraftOptions(sessionId, { checkout: e.target.value as DraftChatOptions['checkout'] })}
        style={selectStyle}
      >
        <option value="project">Project checkout</option>
        <option value="worktree">New worktree</option>
      </select>
      {draft.checkout === 'worktree' && (
        <select
          aria-label="Base branch"
          data-testid="draft-base-ref"
          value={draft.baseRef}
          onChange={(e) => setDraftOptions(sessionId, { baseRef: e.target.value })}
          style={selectStyle}
        >
          <option value="HEAD">from current HEAD</option>
          {branches.map((name) => <option key={name} value={name}>from {name}</option>)}
        </select>
      )}
    </>
  )
}
