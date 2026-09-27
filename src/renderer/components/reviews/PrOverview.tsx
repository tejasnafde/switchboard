/**
 * Overview tab: a failed-checks callout, the description, the activity feed
 * with a comment box, and on the right the merge blockers (and the strategy
 * the header's Merge uses), reviewers and checks with Re-run on a failure.
 */
import { fmtDuration } from '@shared/format'
import { effectiveMergeStrategy, MERGE_STRATEGY_LABEL } from '@shared/pull-request-writes'
import { PR_HOST_LABEL, repoKey, type MergeBlocker, type PrDetail, type PrReviewer, type PrSummary } from '@shared/pull-requests'
import { checkItem } from '@shared/review-context'
import { MarkdownWithCopyControls } from '../chat/MarkdownWithCopyControls'
import { Button } from '../ui/button'
import { useReviewStore } from '../../stores/review-store'
import { Loaded, usePrResource } from './PrDetailPane'
import { PrCommentBox, RerunButton } from './PrWriteControls'
import { shortAgo } from './review-states'
import { Avatar, CardRow, CHECK_ICON, Icon, openExternal, SideCard, type IconName, type IconTone } from './review-ui'
import { LinkedChatsCard } from './PrLinkedChats'
import { askAgent } from './review-to-chat'

const BLOCKER_ICON: Record<MergeBlocker['kind'], { name: IconName; tone: IconTone }> = {
  checks_failed: { name: 'x', tone: 'bad' },
  checks_pending: { name: 'clock', tone: 'dim' },
  unresolved_conversations: { name: 'msg', tone: 'warn' },
  changes_requested: { name: 'msg', tone: 'warn' },
  approvals_missing: { name: 'clock', tone: 'dim' },
  conflicts: { name: 'x', tone: 'bad' },
  draft: { name: 'draft', tone: 'dim' },
}

const REVIEW_LABEL: Record<PrReviewer['state'], { text: string; color?: string }> = {
  approved: { text: 'Approved', color: 'var(--success)' },
  changes_requested: { text: 'Changes requested', color: 'var(--warning)' },
  commented: { text: 'Commented' },
  dismissed: { text: 'Dismissed' },
  pending: { text: 'Review requested' },
}

export function PrOverview({ summary, now }: { summary: PrSummary; now: number }) {
  const { value, retry } = usePrResource(summary, 'detail')
  return (
    <Loaded value={value} retry={retry}>
      {(pr) => <OverviewBody pr={pr} now={now} />}
    </Loaded>
  )
}

function OverviewBody({ pr, now }: { pr: PrDetail; now: number }) {
  const failed = pr.checkList.filter((c) => c.state === 'failure')
  const picked = useReviewStore((s) => s.mergeStrategy[repoKey(pr.ref)])
  const strategy = effectiveMergeStrategy(pr.mergeStrategies, picked)
  const approvals = pr.approvals.required !== null && pr.approvals.required > 0
    ? `${pr.approvals.given} of ${pr.approvals.required}`
    : `${pr.approvals.given} approved`
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-6 px-[22px] py-5">
      <div className="min-w-0">
        {failed.length > 0 && (
          <div className="mb-[22px] flex gap-[10px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-[10px]">
            <Icon name="x" tone="bad" className="mt-[2px]" />
            <div className="min-w-0 flex-1">
              <div className="font-[500]">{failed.length === 1 ? `${failed[0].name} failed` : `${failed.length} checks failed`}</div>
              <div className="text-[12.5px] text-[var(--text-secondary)]">
                {pr.checks.passed} of {pr.checks.total} checks passed.
                {failed[0].description && ` ${failed[0].description}`}
              </div>
            </div>
            {failed[0].url && <Button variant="outline" size="sm" onClick={() => openExternal(failed[0].url!)}>View log</Button>}
            <Button variant="outline" size="sm" onClick={() => void askAgent({ pr: pr.ref, title: pr.title, url: pr.url, items: failed.map(checkItem) })}>
              <Icon name="spark" />Ask the agent
            </Button>
          </div>
        )}
        <section className="mb-[22px]">
          <h3 className="m-0 mb-2 text-[12px] font-[600] text-[var(--text-secondary)]">Description</h3>
          {pr.description
            ? <MarkdownWithCopyControls markdown={pr.description} className="markdown-content max-w-[640px]" />
            : <div className="text-[12.5px] text-[var(--text-muted)]">No description.</div>}
        </section>
        <section>
          <h3 className="m-0 mb-2 text-[12px] font-[600] text-[var(--text-secondary)]">Activity</h3>
          {pr.activity.length === 0 && <div className="text-[12.5px] text-[var(--text-muted)]">Nothing yet.</div>}
          {pr.activity.map((a) => (
            <div key={a.id} className="grid grid-cols-[22px_1fr_auto] gap-[10px] border-b border-[var(--border)] py-2 last:border-b-0">
              {a.actor ? <Avatar person={a.actor} /> : <span />}
              <div className="min-w-0">
                {a.actor && <b className="font-[600]">{a.actor.displayName}</b>} {a.summary}
                {a.detail && <div className="truncate text-[12.5px] text-[var(--text-secondary)]">{a.detail}</div>}
              </div>
              <span className="text-[12px] text-[var(--text-muted)] tabular-nums">{shortAgo(a.at, now)}</span>
            </div>
          ))}
          <PrCommentBox pr={pr} />
        </section>
      </div>
      <div>
        {pr.state === 'open' && (
          <SideCard title="Merge" right={strategy ? MERGE_STRATEGY_LABEL[strategy].toLowerCase() : undefined}>
            <div className="p-3">
              {pr.mergeBlockers.length > 0 ? (
                <>
                  <ul className="m-0 mb-[10px] list-none p-0">
                    {pr.mergeBlockers.map((b) => (
                      <li key={b.kind} className="flex items-center gap-2 py-[2px] text-[12.5px] text-[var(--text-secondary)]">
                        <Icon {...BLOCKER_ICON[b.kind]} />{b.label}
                      </li>
                    ))}
                  </ul>
                  <div className="text-[12.5px] text-[var(--text-secondary)]">
                    {pr.mergeBlockers.length === 1 ? 'Merging opens up when this clears.' : `Merging opens up when all ${pr.mergeBlockers.length} clear.`}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
                  <Icon name="ok" tone="ok" />Nothing blocks merging on {PR_HOST_LABEL[pr.ref.host]}.
                </div>
              )}
            </div>
          </SideCard>
        )}
        <SideCard title="Reviewers" right={pr.reviewers.length > 0 ? approvals : undefined}>
          {pr.reviewers.length === 0 && <CardRow><span className="text-[var(--text-muted)]">No reviewers yet.</span></CardRow>}
          {pr.reviewers.map((r) => (
            <CardRow key={r.person.login}>
              <Avatar person={r.person} />{r.person.displayName}
              <span className="ml-auto text-[12px]" style={{ color: REVIEW_LABEL[r.state].color ?? 'var(--text-secondary)' }}>{REVIEW_LABEL[r.state].text}</span>
            </CardRow>
          ))}
        </SideCard>
        <SideCard title="Checks" right={pr.checks.total > 0 ? `${pr.checks.passed} of ${pr.checks.total}` : undefined}>
          {pr.checkList.length === 0 && <CardRow><span className="text-[var(--text-muted)]">No checks reported.</span></CardRow>}
          {pr.checkList.map((c) => (
            <CardRow key={c.id}>
              <Icon {...CHECK_ICON[c.state]} />
              <span className="min-w-0 truncate">{c.name}</span>
              <span className="ml-auto text-[12px] text-[var(--text-secondary)] tabular-nums">
                {c.durationMs !== null ? fmtDuration(c.durationMs) : c.state === 'pending' ? 'running' : ''}
              </span>
              <RerunButton pr={pr} check={c} />
            </CardRow>
          ))}
        </SideCard>
        <LinkedChatsCard pr={pr} />
      </div>
    </div>
  )
}
