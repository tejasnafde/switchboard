/**
 * Checks tab: every check on the head commit, failures first. Details open
 * on the host in the system browser.
 */
import { fmtDuration } from '@shared/format'
import { HOST_CAPABILITIES, type CheckState, type PrCheck, type PrSummary } from '@shared/pull-requests'
import { checkItem } from '@shared/review-context'
import { Button } from '../ui/button'
import { Loaded, usePrResource } from './PrDetailPane'
import { CHECK_ICON, Icon, openExternal } from './review-ui'
import { askAgent } from './review-to-chat'

const ORDER: Record<CheckState, number> = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }

export function PrChecks({ summary }: { summary: PrSummary }) {
  const { value, retry } = usePrResource(summary, 'checks')
  const exact = HOST_CAPABILITIES[summary.ref.host].exactCheckDurations
  return <Loaded value={value} retry={retry}>{(data) => <CheckList pr={summary} checks={data} exactDurations={exact} />}</Loaded>
}

function CheckList({ pr, checks, exactDurations }: { pr: PrSummary; checks: PrCheck[]; exactDurations: boolean }) {
  if (checks.length === 0) return <div className="p-[22px] text-[12.5px] text-[var(--text-muted)]">No checks reported for the head commit.</div>
  const sorted = [...checks].sort((a, b) => ORDER[a.state] - ORDER[b.state])
  return (
    <div className="max-w-[900px] px-[22px] py-[18px]">
      <div className="overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)]">
        {sorted.map((c) => (
          <div key={c.id} className="flex items-center gap-[10px] px-3 py-2 text-[12.5px] [&+&]:border-t [&+&]:border-[var(--border)]">
            <Icon {...CHECK_ICON[c.state]} />
            <div className="min-w-0 flex-1">
              <div className="truncate">{c.name}</div>
              {c.description && <div className="truncate text-[12px] text-[var(--text-secondary)]">{c.description}</div>}
            </div>
            <span
              className="text-[12px] text-[var(--text-secondary)] tabular-nums"
              title={exactDurations ? undefined : 'Time between the first and last status the check posted'}
            >
              {c.durationMs !== null ? `${exactDurations ? '' : 'about '}${fmtDuration(c.durationMs)}` : c.state === 'pending' ? 'running' : ''}
            </span>
            {c.state === 'failure' && (
              <Button variant="ghost" size="sm" onClick={() => void askAgent({ pr: pr.ref, title: pr.title, url: pr.url, items: [checkItem(c)] })}>
                <Icon name="spark" />Ask the agent
              </Button>
            )}
            {c.url && (
              <Button variant="ghost" size="sm" onClick={() => openExternal(c.url!)}><Icon name="ext" />Details</Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
