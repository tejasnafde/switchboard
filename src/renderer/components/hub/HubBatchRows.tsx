import { formatGiB, HUB_MAIN_CHECKOUT_WARNING, type HubBatchView } from '@shared/hub'
import { agentLabel } from '@shared/types'

/** The body of a `start_children` card: one row per child, the disk it needs, and the main checkout warning. */
export function HubBatchRows({ view }: { view: HubBatchView }) {
  return (
    <div
      data-testid="approval-hub-batch"
      style={{ padding: '8px 12px', fontSize: '11.5px', color: 'var(--text-secondary)', maxHeight: '320px', overflow: 'auto' }}
    >
      <div>
        Start {view.rows.length} child chat{view.rows.length === 1 ? '' : 's'}:
      </div>
      <ol style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
        {view.rows.map((r, i) => (
          <li key={i} style={{ marginTop: '4px' }}>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.title}</div>
            <div style={{ color: 'var(--text-muted)' }}>
              {agentLabel(r.agent)}
              {r.model ? ` ${r.model}` : ''} · {r.mode} ·{' '}
              {r.location === 'project' ? 'project folder' : `worktree off ${r.baseRef} · deps: ${r.deps}`}
            </div>
          </li>
        ))}
      </ol>
      {view.needBytes !== null && view.freeBytes !== null && (
        <div style={{ marginTop: '6px' }}>
          Disk: needs about {formatGiB(view.needBytes)}, {formatGiB(view.freeBytes)} free.
        </div>
      )}
      {view.mainCheckout && <div style={{ marginTop: '6px', color: 'var(--warning)' }}>{HUB_MAIN_CHECKOUT_WARNING}</div>}
    </div>
  )
}
