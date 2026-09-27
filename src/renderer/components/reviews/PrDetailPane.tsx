/**
 * One pull request: the header (host path, title, branches, size, and Merge
 * or Review) and the Overview / Files / Conversations / Checks tabs. Each tab loads its own
 * data on first open through the review store.
 */
import { useEffect, type ReactNode } from 'react'
import { PR_HOST_LABEL, prKey, type PrSummary } from '@shared/pull-requests'
import { useReviewStore, type Loadable, type ReviewTab, type TabData, type TabResource } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { PrChecks } from './PrChecks'
import { PrConversations } from './PrConversations'
import { PrFiles } from './PrFiles'
import { PrHeaderActions } from './PrHeaderActions'
import { PrOverview } from './PrOverview'
import { agoPhrase, describePrError } from './review-states'
import { Icon, NoticeView, openExternal } from './review-ui'

const TABS: Array<{ id: ReviewTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'checks', label: 'Checks' },
]

function tabCount(tab: ReviewTab, pr: PrSummary): string | null {
  switch (tab) {
    case 'files':
      return pr.changedFiles !== null ? String(pr.changedFiles) : null
    case 'conversations':
      return pr.unresolvedConversations ? `${pr.unresolvedConversations} open` : null
    case 'checks':
      if (pr.checks.state === 'failure') return `${pr.checks.failed} failed`
      if (pr.checks.state === 'pending') return 'running'
      if (pr.checks.state === 'success') return 'passing'
      return null
    default:
      return null
  }
}

/** Loads one resource for the open PR, and again after the list drops it as changed. */
export function usePrResource<K extends TabResource>(pr: PrSummary, resource: K) {
  const key = prKey(pr.ref)
  const value = useReviewStore((s) => s.resources[key]?.[resource]) as Loadable<TabData[K]> | undefined
  const missing = value === undefined
  useEffect(() => {
    if (missing) void useReviewStore.getState().load(pr.ref, resource)
  }, [key, missing, pr.ref, resource])
  const retry = () => void useReviewStore.getState().load(pr.ref, resource, { force: true })
  return { value, retry }
}

export function Loaded<T>({ value, retry, children }: { value: Loadable<T> | undefined; retry: () => void; children: (data: T) => ReactNode }) {
  if (!value || value.status === 'loading') return <div className="p-[22px] text-[12.5px] text-[var(--text-muted)]">Loading…</div>
  if (value.status === 'error') {
    return (
      <div className="max-w-[640px] p-[22px]">
        <NoticeView notice={describePrError(value.error)} onAction={() => retry()} />
      </div>
    )
  }
  return <>{children(value.data)}</>
}

export function PrDetailPane({ summary, now }: { summary: PrSummary; now: number }) {
  const tab = useReviewStore((s) => s.tab)
  const setTab = useReviewStore((s) => s.setTab)
  const detail = useReviewStore((s) => s.resources[prKey(summary.ref)]?.detail)
  // The detail read fills in what the list may not carry (Bitbucket sizes).
  const pr: PrSummary = detail?.status === 'ok' ? detail.data : summary
  const host = PR_HOST_LABEL[pr.ref.host]
  const byline = pr.viewer.isAuthor
    ? `opened by you ${agoPhrase(pr.createdAt, now)}`
    : `by ${pr.author.displayName} ${agoPhrase(pr.createdAt, now)}`

  return (
    <>
      <header className="border-b border-[var(--border)] px-[22px] pt-4">
        <div className="flex items-center gap-[6px] text-[12px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-[5px] text-[var(--text-secondary)]"><Icon name="pr" />{host}</span>
          <span aria-hidden="true">/</span>{pr.ref.owner}<span aria-hidden="true">/</span>{pr.ref.name}
        </div>
        <div className="mt-[6px] flex items-start gap-3">
          <h2 className="m-0 min-w-0 flex-1 text-[17px] font-[600] tracking-[-0.01em]">
            {pr.title} <span className="font-[400] text-[var(--text-muted)]">#{pr.ref.number}</span>
          </h2>
          <Button variant="ghost" size="sm" onClick={() => openExternal(pr.url)}>
            <Icon name="ext" />Open in {host}
          </Button>
          <PrHeaderActions pr={pr} />
        </div>
        <div className="mt-[6px] mb-3 flex flex-wrap items-center gap-[6px] text-[12.5px] text-[var(--text-secondary)]">
          <Branch name={pr.sourceBranch} />into<Branch name={pr.targetBranch} />
          <Dot />{byline}
          {pr.state === 'merged' && pr.mergedAt !== null && <><Dot />merged {agoPhrase(pr.mergedAt, now)}</>}
          {pr.draft && <><Dot />draft</>}
          {pr.viewer.isRequestedReviewer && <><Dot />you were asked to review</>}
          {pr.additions !== null && pr.deletions !== null && (
            <><Dot /><span className="tabular-nums">+{pr.additions} −{pr.deletions}</span>{pr.changedFiles !== null && ` in ${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'}`}</>
          )}
        </div>
        <div role="tablist" aria-label="Pull request" className="flex gap-[22px]">
          {TABS.map((t) => {
            const count = tabCount(t.id, pr)
            const active = t.id === tab
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-[6px] border-0 border-b-2 border-solid bg-transparent px-0 pt-[9px] pb-[10px] text-[13px]',
                  active ? 'border-[var(--text-primary)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                {t.label}
                {count && <span className="text-[12px] text-[var(--text-muted)]">{count}</span>}
              </button>
            )
          })}
        </div>
      </header>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <PrOverview summary={summary} now={now} />}
        {tab === 'files' && <PrFiles summary={summary} now={now} />}
        {tab === 'conversations' && <PrConversations summary={summary} now={now} />}
        {tab === 'checks' && <PrChecks summary={summary} />}
      </div>
    </>
  )
}

function Branch({ name }: { name: string }) {
  return <span className="rounded-[5px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[6px] py-px font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--text-primary)]">{name}</span>
}

function Dot() {
  return <span aria-hidden="true" className="text-[var(--text-muted)]">·</span>
}
