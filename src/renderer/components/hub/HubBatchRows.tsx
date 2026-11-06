import {
  formatGiB,
  HUB_MAIN_CHECKOUT_WARNING,
  hubRemoteDiskLine,
  hubTransportTag,
  type HubBatchRowView,
  type HubBatchView,
} from '@shared/hub'
import { agentLabel } from '@shared/types'
import { AgentMark } from '../ui/agent-mark'
import { MachineBadge } from './MachineBadge'

/** Agent, model, and for a child on another machine its account; the machine follows as a badge. */
function rowWho(r: HubBatchRowView): string {
  const agent = `${agentLabel(r.agent)}${r.model ? ` ${r.model}` : ''}`
  return r.machine && r.account ? `${agent} · ${r.account}` : agent
}

function rowPlace(r: HubBatchRowView): string {
  if (r.location === 'project') return 'project folder'
  return `worktree off ${r.baseRef} · deps: ${r.deps}`
}

/** The body of a `start_children` card: one row per child, the disk it needs per machine, and the main checkout warning. */
export function HubBatchRows({ view }: { view: HubBatchView }) {
  return (
    <div
      data-testid="approval-hub-batch"
      style={{
        padding: '8px 12px',
        fontSize: '11.5px',
        color: 'var(--text-secondary)',
        maxHeight: '320px',
        overflow: 'auto',
      }}
    >
      <div>
        Start {view.rows.length} child chat{view.rows.length === 1 ? '' : 's'}:
      </div>
      <ol style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
        {view.rows.map((r, i) => (
          <li key={i} style={{ marginTop: '4px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--text-primary)' }}
            >
              {/* The line under it names the agent, so the mark is decoration. */}
              <AgentMark agent={r.agent} />
              {r.title}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>
              {rowWho(r)}
              {r.machine && (
                <>
                  {' on '}
                  <MachineBadge name={r.machine.name} transport={hubTransportTag(r.machine)} />
                </>
              )}
              {` · ${r.mode} · ${rowPlace(r)}`}
            </div>
            {r.machine && r.clone && r.remoteProjectPath && (
              <div style={{ color: 'var(--text-muted)' }}>
                Clones into {r.remoteProjectPath} on {r.machine.name}.
              </div>
            )}
          </li>
        ))}
      </ol>
      {view.needBytes !== null && view.freeBytes !== null && (
        <div style={{ marginTop: '6px' }}>
          Disk: needs about {formatGiB(view.needBytes)}, {formatGiB(view.freeBytes)} free.
        </div>
      )}
      {(view.remoteDisk ?? []).map((d) => (
        <div key={d.machineId} style={{ marginTop: '6px' }}>
          {hubRemoteDiskLine(d)}
        </div>
      ))}
      {view.mainCheckout && (
        <div style={{ marginTop: '6px', color: 'var(--warning)' }}>{HUB_MAIN_CHECKOUT_WARNING}</div>
      )}
    </div>
  )
}
