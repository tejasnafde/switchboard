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
 * branch, a draft picks the checkout: the project, a new worktree and its
 * base, or a worktree that already exists.
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
  const [refs, setRefs] = useState<Array<{ name: string; isRemote: boolean; worktreePath: string | null }>>([])

  // One read serves both lists: local branches to base a new worktree on, and
  // the worktrees already on disk a chat can join.
  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    window.api.git.listRefs(cwd)
      .then((result) => { if (!cancelled && result.ok) setRefs(result.refs) })
      .catch((err: unknown) => log.warn('listRefs failed', err))
    return () => { cancelled = true }
  }, [cwd])

  const branches = refs.filter((r) => !r.isRemote).map((r) => r.name)
  const worktrees = refs.flatMap((r) =>
    !r.isRemote && r.worktreePath && r.worktreePath !== cwd ? [{ path: r.worktreePath, branch: r.name }] : [])

  const pickCheckout = (checkout: DraftChatOptions['checkout']) => setDraftOptions(sessionId, {
    checkout,
    ...(checkout === 'existing' && !draft.existing && worktrees[0] ? { existing: worktrees[0] } : {}),
  })

  return (
    <>
      <select
        aria-label="Workspace"
        data-testid="draft-workspace"
        value={draft.checkout}
        onChange={(e) => pickCheckout(e.target.value as DraftChatOptions['checkout'])}
        style={selectStyle}
      >
        <option value="project">Project checkout</option>
        <option value="worktree">New worktree</option>
        {(worktrees.length > 0 || draft.checkout === 'existing') && <option value="existing">Existing worktree</option>}
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
      {draft.checkout === 'existing' && (
        <select
          aria-label="Worktree"
          data-testid="draft-existing-worktree"
          value={draft.existing?.path ?? ''}
          onChange={(e) => {
            const picked = worktrees.find((w) => w.path === e.target.value)
            if (picked) setDraftOptions(sessionId, { existing: picked })
          }}
          style={selectStyle}
        >
          {worktrees.map((w) => <option key={w.path} value={w.path}>{w.branch}</option>)}
        </select>
      )}
    </>
  )
}
