/**
 * Reviews (the third view beside Chats and Board): pull requests from the
 * projects' GitHub and Bitbucket remotes, grouped by what you do next, with
 * a read-only detail pane. Refreshes on window focus and every 5 minutes
 * while visible, never faster (`shared/pull-request-refresh`).
 */
import { useEffect, useMemo } from 'react'
import { prKey } from '@shared/pull-requests'
import { filterPullRequests, groupPullRequests } from '@shared/pull-request-groups'
import { nextRefreshDelay, PR_REFRESH_INTERVAL_MS } from '@shared/pull-request-refresh'
import { findSummary, useReviewStore } from '../../stores/review-store'
import { cn } from '../../lib/utils'
import { PrDetailPane } from './PrDetailPane'
import { reviewListState, rowSubtitle, type ReviewNotice } from './review-states'
import { Icon, NoticeView, ROW_ICON } from './review-ui'

export function ReviewsView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const list = useReviewStore((s) => s.list)
  const listError = useReviewStore((s) => s.listError)
  const loading = useReviewStore((s) => s.loading)
  const lastFetchAt = useReviewStore((s) => s.lastFetchAt)
  const filter = useReviewStore((s) => s.filter)
  const selectedKey = useReviewStore((s) => s.selectedKey)
  const { setVisible, setFilter, select, refresh } = useReviewStore.getState()

  // Mounted only while the view is shown, so mounted means visible.
  useEffect(() => {
    setVisible(true)
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
  }, [setVisible, refresh])

  const now = lastFetchAt ?? Date.now()
  const state = reviewListState(list, listError)
  const groups = useMemo(() => (list ? groupPullRequests(filterPullRequests(list.prs, filter), now) : []), [list, filter, now])
  const firstKey = groups[0]?.prs[0] ? prKey(groups[0].prs[0].pr.ref) : null

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
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-[6px] pb-[10px]" aria-busy={loading && !list}>
          {state.kind === 'loading' && <div className="px-2 py-3 text-[12px] text-[var(--text-muted)]">Loading pull requests…</div>}
          {state.kind === 'blocked' && <div className="px-1 pt-1"><NoticeView notice={state.notice} onAction={onNotice} compact /></div>}
          {state.kind === 'ready' && (
            <>
              {state.notices.map((n) => <div key={n.id} className="px-1 pt-1"><NoticeView notice={n} onAction={onNotice} compact /></div>)}
              {groups.length === 0 && (
                <div className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                  {filter ? 'No pull requests match the filter.' : 'Nothing open that involves you.'}
                </div>
              )}
              {groups.map((group) => (
                <section key={group.id} data-pr-group={group.id}>
                  <h3 className="m-0 flex justify-between px-2 pt-3 pb-1 text-[11px] font-[600] text-[var(--text-muted)]">
                    <span>{group.label}</span>
                    <span className="tabular-nums">{group.prs.length}</span>
                  </h3>
                  {group.prs.map(({ pr, status }) => {
                    const key = prKey(pr.ref)
                    const icon = ROW_ICON[status.icon]
                    const active = key === selectedKey
                    return (
                      <button
                        key={key}
                        type="button"
                        data-pr-row={key}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => select(key)}
                        className={cn(
                          'grid w-full cursor-pointer grid-cols-[16px_1fr] gap-2 rounded-[7px] border-none px-2 py-[7px] text-left text-inherit',
                          active ? 'bg-[var(--bg-active)]' : 'bg-transparent hover:bg-[var(--bg-hover)]',
                        )}
                      >
                        <span className="mt-[2px]" title={icon.label}><Icon name={icon.name} tone={icon.tone} /></span>
                        <span className="min-w-0">
                          <span className={cn('block truncate font-[500]', pr.state === 'merged' && 'text-[var(--text-secondary)]')}>{pr.title}</span>
                          <span className="block truncate text-[12px] text-[var(--text-secondary)]">{rowSubtitle(pr, status.phrase, now)}</span>
                        </span>
                      </button>
                    )
                  })}
                </section>
              ))}
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
    </div>
  )
}
