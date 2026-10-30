import { hubChildCount, type HubSettleRowView, type HubSettleView } from '@shared/hub'

function gitLine(r: HubSettleRowView): string {
  if (r.worktree === 'none') return 'No worktree of its own'
  const merged = r.merged === null ? 'merge unknown' : r.merged ? 'merged' : 'not merged'
  const clean = r.clean === null ? 'state unknown' : r.clean ? 'clean' : 'has changes'
  return `${merged} · ${clean} · ${r.worktree === 'remove' ? 'worktree to be removed' : `worktree kept: ${r.keepReason}`}`
}

/** The body of a settle card: per child its merge state, what happens to its worktree, and what is still open on it. */
export function HubSettleRows({ view }: { view: HubSettleView }) {
  return (
    <div
      data-testid="approval-hub-settle"
      style={{
        padding: '8px 12px',
        fontSize: '11.5px',
        color: 'var(--text-secondary)',
        maxHeight: '320px',
        overflow: 'auto',
      }}
    >
      <div>Settle {hubChildCount(view.rows.length)}:</div>
      <ol style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
        {view.rows.map((r) => (
          <li key={r.childId} style={{ marginTop: '4px' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              {r.title}
              {r.branch ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> {r.branch}</span> : null}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>{gitLine(r)}</div>
            {r.blockers.length > 0 && <div style={{ color: 'var(--warning)' }}>{r.blockers.join(' ')}</div>}
          </li>
        ))}
      </ol>
      <div style={{ marginTop: '6px' }}>
        Stops their sessions, closes their open cards, cancels their auto-resumes and archives them. Each worktree that
        is clean and merged goes, its dependency links first. Branches with commits stay; nothing is pushed.
      </div>
      {view.archiveParent && <div style={{ marginTop: '6px' }}>Then this chat is archived.</div>}
    </div>
  )
}
