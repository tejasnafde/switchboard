/**
 * Reviews (the third view beside Chats and Board): pull requests from the
 * projects' GitHub and Bitbucket remotes, grouped by what you do next or by
 * repository, with the detail pane beside. Refreshes on window focus and
 * every 5 minutes while visible, never faster (`shared/pull-request-refresh`).
 */
import { useEffect, useMemo } from 'react'
import { prKey, type PrSummary } from '@shared/pull-requests'
import { filterPullRequests, groupPullRequests, groupPullRequestsByRepo, prRowStatus, type PrGroup, type PrGroupBy, type PrRowStatus } from '@shared/pull-request-groups'
import { nextRefreshDelay, PR_REFRESH_INTERVAL_MS } from '@shared/pull-request-refresh'
import { findSummary, useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { PrDetailPane } from './PrDetailPane'
import { reviewListState, rowSubtitle, type ReviewNotice } from './review-states'
import { Icon, NoticeView, ROW_ICON } from './review-ui'
import { AskChatDialog } from './PrLinkedChats'

/** A status group (`collapsed: null`, never folds) or a repository section. */
interface ListSection {
  id: string
  label: string
  count: number
  collapsed: boolean | null
  prs: PrGroup['prs']
}

export function ReviewsView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const list = useReviewStore((s) => s.list)
  const listError = useReviewStore((s) => s.listError)
  const loading = useReviewStore((s) => s.loading)
  const lastFetchAt = useReviewStore((s) => s.lastFetchAt)
  const filter = useReviewStore((s) => s.filter)
  const selectedKey = useReviewStore((s) => s.selectedKey)
  const groupBy = useReviewStore((s) => s.groupBy)
  const collapsedRepos = useReviewStore((s) => s.collapsedRepos)
  const showHidden = useReviewStore((s) => s.showHidden)
  const { setVisible, setFilter, select, refresh, setGroupBy, toggleRepo, setShowHidden, hydrateSettings } = useReviewStore.getState()

  // Mounted only while the view is shown, so mounted means visible.
  useEffect(() => {
    setVisible(true)
    void hydrateSettings()
    void refresh('open')
    const onFocus = () => void refresh('focus')
    window.addEventListener('focus', onFocus)
    let timer: ReturnType<typeof setTimeout>
    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        void refresh('interval')
        schedule(PR_REFRESH_INTERVAL_MS)
      }, delay)
    }
    schedule(Math.max(nextRefreshDelay(useReviewStore.getState().lastFetchAt, Date.now()), 1000))
    return () => {
      setVisible(false)
      window.removeEventListener('focus', onFocus)
      clearTimeout(timer)
    }
  }, [setVisible, refresh, hydrateSettings])

  const now = lastFetchAt ?? Date.now()
  const state = reviewListState(list, listError)
  const hidden = useMemo(() => new Set(list?.hidden ?? []), [list])
  const hiddenCount = useMemo(() => (list ? list.prs.filter((pr) => hidden.has(prKey(pr.ref)) && prRowStatus(pr, now)).length : 0), [list, hidden, now])
  const shown = useMemo(() => {
    if (!list) return []
    const prs = showHidden ? list.prs : list.prs.filter((pr) => !hidden.has(prKey(pr.ref)))
    return filterPullRequests(prs, filter)
  }, [list, hidden, showHidden, filter])
  const sections = useMemo<ListSection[]>(
    () => (groupBy === 'repository'
      ? groupPullRequestsByRepo(shown, now, collapsedRepos, filter.trim() !== '').map((r) => ({ id: r.key, label: r.label, count: r.count, collapsed: r.collapsed, prs: r.prs }))
      : groupPullRequests(shown, now).map((g) => ({ id: g.id, label: g.label, count: g.prs.length, collapsed: null, prs: g.prs }))),
    [groupBy, shown, now, collapsedRepos, filter],
  )
  const firstRow = sections.find((sec) => sec.prs.length > 0)?.prs[0]
  const firstKey = firstRow ? prKey(firstRow.pr.ref) : null

  // Keep a selection: the first row until the user picks one, and again if theirs leaves the list.
  useEffect(() => {
    if (!list) return
    if (!findSummary(list, selectedKey) && firstKey) select(firstKey)
  }, [list, selectedKey, firstKey, select])

  const onNotice = (action: ReviewNotice['action']) => {
    if (action === 'settings') onOpenSettings()
    else if (action === 'retry') void refresh('manual')
  }

  const selected = findSummary(list, selectedKey)

  return (
    <div data-reviews-view className="flex min-w-0 flex-1 bg-[var(--bg-primary)] text-[13px] text-[var(--text-primary)]">
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="px-[10px] pt-3 pb-2">
          <label className="flex h-7 items-center gap-[6px] rounded-[6px] border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[var(--text-muted)]">
            <Icon name="search" />
            <input
              aria-label="Filter pull requests"
              placeholder="Filter pull requests"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
          <GroupByToggle value={groupBy} onChange={setGroupBy} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-[6px] pb-[10px]" aria-busy={loading && !list}>
          {state.kind === 'loading' && <div className="px-2 py-3 text-[12px] text-[var(--text-muted)]">Loading pull requests…</div>}
          {state.kind === 'blocked' && <div className="px-1 pt-1"><NoticeView notice={state.notice} onAction={onNotice} compact /></div>}
          {state.kind === 'ready' && (
            <>
              {state.notices.map((n) => <div key={n.id} className="px-1 pt-1"><NoticeView notice={n} onAction={onNotice} compact /></div>)}
              {sections.length === 0 && (
                <div className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                  {filter ? 'No pull requests match the filter.' : 'Nothing open that involves you.'}
                </div>
              )}
              {sections.map((section) => (
                <section key={section.id} data-pr-group={groupBy === 'status' ? section.id : undefined} data-pr-repo={groupBy === 'repository' ? section.id : undefined}>
                  {section.collapsed === null ? (
                    <h3 className="m-0 flex justify-between px-2 pt-3 pb-1 text-[11px] font-[600] text-[var(--text-muted)]">
                      <span>{section.label}</span>
                      <span className="tabular-nums">{section.count}</span>
                    </h3>
                  ) : (
                    <h3 className="m-0 pt-2">
                      <button
                        type="button"
                        aria-expanded={!section.collapsed}
                        onClick={() => toggleRepo(section.id)}
                        className="flex w-full cursor-pointer items-center gap-[6px] rounded-[6px] border-none bg-transparent px-2 py-1 text-left text-[11.5px] font-[600] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                      >
                        <Icon name="chev" size={12} className={cn('text-[var(--text-muted)] transition-transform', section.collapsed && '-rotate-90')} />
                        <span className="min-w-0 flex-1 truncate">{section.label}</span>
                        <span className="font-[400] text-[var(--text-muted)] tabular-nums">{section.count}</span>
                      </button>
                    </h3>
                  )}
                  {section.prs.map(({ pr, status }) => (
                    <PrRow key={prKey(pr.ref)} pr={pr} status={status} now={now} active={prKey(pr.ref) === selectedKey} hidden={hidden.has(prKey(pr.ref))} onSelect={select} />
                  ))}
                </section>
              ))}
              {hiddenCount > 0 && (
                <div data-pr-hidden-row className="flex items-center gap-[6px] px-2 pt-3 text-[12px] text-[var(--text-muted)]">
                  <span className="tabular-nums">{hiddenCount} hidden</span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setShowHidden(!showHidden)}
                    className="cursor-pointer border-none bg-transparent p-0 text-[12px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
                  >
                    {showHidden ? 'Hide them' : 'Show'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <PrDetailPane key={prKey(selected.ref)} summary={selected} now={now} />
        ) : (
          <div className="m-auto text-[12.5px] text-[var(--text-muted)]">{state.kind === 'loading' ? '' : 'Pick a pull request.'}</div>
        )}
      </main>
      <AskChatDialog />
    </div>
  )
}

function GroupByToggle({ value, onChange }: { value: PrGroupBy; onChange: (value: PrGroupBy) => void }) {
  const options: Array<{ id: PrGroupBy; label: string }> = [{ id: 'status', label: 'By status' }, { id: 'repository', label: 'By repository' }]
  return (
    <div role="group" aria-label="Group pull requests" className="mt-2 flex rounded-[6px] border border-[var(--border)] bg-[var(--bg-primary)] p-[2px]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex-1 cursor-pointer rounded-[4px] border-none px-2 py-[3px] text-[11.5px]',
            value === o.id ? 'bg-[var(--bg-active)] text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function PrRow({ pr, status, now, active, hidden, onSelect }: { pr: PrSummary; status: PrRowStatus; now: number; active: boolean; hidden: boolean; onSelect: (key: string) => void }) {
  const key = prKey(pr.ref)
  const icon = ROW_ICON[status.icon]
  const subtitle = rowSubtitle(pr, status.phrase, now)
  return (
    <button
      type="button"
      data-pr-row={key}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(key)}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[16px_1fr] gap-2 rounded-[7px] border-none px-2 py-[7px] text-left text-inherit',
        active ? 'bg-[var(--bg-active)]' : 'bg-transparent hover:bg-[var(--bg-hover)]',
        hidden && 'opacity-60',
      )}
    >
      <span className="mt-[2px]" title={icon.label}><Icon name={icon.name} tone={icon.tone} /></span>
      <span className="min-w-0">
        <span className={cn('block truncate font-[500]', pr.state === 'merged' && 'text-[var(--text-secondary)]')}>{pr.title}</span>
        <span className="block truncate text-[12px] text-[var(--text-secondary)]">{hidden ? `${subtitle} · hidden` : subtitle}</span>
      </span>
    </button>
  )
}
