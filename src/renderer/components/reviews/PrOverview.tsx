/**
 * Overview tab: the merge conflicts and failed-checks callouts, the
 * description, the activity feed with a comment box, and on the right the
 * merge blockers (and the strategy the header's Merge uses), reviewers and
 * checks with Re-run on a failure.
 */
import { fmtDuration } from '@shared/format'
import { effectiveMergeStrategy, MERGE_STRATEGY_LABEL } from '@shared/pull-request-writes'
import { PR_HOST_LABEL, repoKey, type MergeBlocker, type PrDetail, type PrSummary } from '@shared/pull-requests'
import { checkItem, conflictsItem } from '@shared/review-context'
import { MarkdownWithCopyControls } from '../chat/MarkdownWithCopyControls'
import { Button } from '../ui/button'
import { useReviewStore } from '../../stores/review-store'
import { Loaded, usePrResource } from './PrDetailPane'
import { PrCommentBox, RerunButton } from './PrWriteControls'
import { shortAgo } from './review-states'
import { Avatar, CardRow, CHECK_ICON, Icon, openExternal, SideCard, type IconName, type IconTone } from './review-ui'
import { LinkedChatsCard } from './PrLinkedChats'
import { ReviewersCard } from './PrReviewers'
import { askAgent } from './review-to-chat'

const BLOCKER_ICON: Record<MergeBlocker['kind'], { name: IconName; tone: IconTone }> = {
  checks_failed: { name: 'x', tone: 'bad' },
  checks_pending: { name: 'clock', tone: 'dim' },
  unresolved_conversations: { name: 'msg', tone: 'warn' },
  changes_requested: { name: 'msg', tone: 'warn' },
  approvals_missing: { name: 'clock', tone: 'dim' },
  conflicts: { name: 'conflict', tone: 'warn' },
  draft: { name: 'draft', tone: 'dim' },
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
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-6 px-[22px] py-5">
      <div className="min-w-0">
        {pr.state === 'open' && pr.mergeConflicts && <ConflictCallout pr={pr} />}
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
        <ReviewersCard pr={pr} />
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

function Path({ path }: { path: string }) {
  return <code className="rounded-[4px] bg-[var(--bg-tertiary)] px-1 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--text-primary)]">{path}</code>
}

/** Names the conflicted files when the host does (Bitbucket), and hands the merge to the agent as one review pill. */
function ConflictCallout({ pr }: { pr: PrDetail }) {
  const files = pr.conflictedFiles
  return (
    <div data-pr-conflict-callout className="mb-[22px] flex gap-[10px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-[10px]">
      <Icon name="conflict" tone="warn" className="mt-[2px]" />
      <div className="min-w-0 flex-1">
        <div className="font-[500]">This branch has conflicts with {pr.targetBranch}</div>
        <div className="text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
          {files.length > 0
            ? <>{files.map((f, i) => <span key={f}>{i > 0 && (i === files.length - 1 ? ' and ' : ', ')}<Path path={f} /></span>)} {files.length === 1 ? 'conflicts' : 'conflict'}. </>
            : `${PR_HOST_LABEL[pr.ref.host]} does not say which files. `}
          Merge {pr.targetBranch} into the branch and resolve them, then push.
        </div>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void askAgent({ pr: pr.ref, title: pr.title, url: pr.url, items: [conflictsItem(pr)] })}>
          <Icon name="spark" />Ask the agent to resolve
        </Button>
      </div>
    </div>
  )
}
