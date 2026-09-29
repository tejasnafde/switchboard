/**
 * Reviews view state: the pull request list, the selected PR and its tabs,
 * each tab's data loaded on first open and kept per PR until the list shows
 * that PR changed. When to refresh is decided by `shared/pull-request-refresh`.
 */
import { create } from 'zustand'
import type { InlineCommentInput, PrResource } from '@shared/pull-request-writes'
import { prKey, repoKey, type RepoRef, type MergeStrategy, type PrChangedFile, type PrCheck, type PrConversation, type PrDetail, type PrError, type PrListData, type PrRef, type PrResult, type PrReviewerCandidate, type PrSummary } from '@shared/pull-requests'
import { pullRequestChanged, shouldRefreshPullRequests, type PrRefreshReason } from '@shared/pull-request-refresh'
import { toggleCollapsed, type PrGroupBy } from '@shared/pull-request-groups'
import type { PrLinkChat } from '@shared/pull-request-links'
import type { ReviewContext } from '@shared/review-context'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:reviews')

/**
 * The newest load per `prKey:resource`. A load writes back only while it is
 * still the newest, and a refresh that drops a changed PR's tabs forgets its
 * tokens, so a read started before the change cannot restore stale data.
 */
const loadTokens = new Map<string, number>()
let loadSeq = 0
/** A write landed while a list read was in flight: that read may predate it, so one more follows, keeping this PR's tabs. */
let listAfterWrite: string | null = null

export type ReviewTab = 'overview' | 'files' | 'conversations' | 'checks'

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T; version: number }
  | { status: 'error'; error: PrError }

export type TabData = {
  detail: PrDetail
  files: PrChangedFile[]
  conversations: PrConversation[]
  checks: PrCheck[]
}
export type TabResource = keyof TabData & PrResource

/** A line comment held for the review, in this window only until it is submitted. */
export interface PendingComment extends InlineCommentInput {
  id: string
}

let pendingSeq = 0

const GROUP_BY_KEY = 'reviews.groupBy'
const COLLAPSED_REPOS_KEY = 'reviews.collapsedRepos'

function persist(key: string, value: string): void {
  window.api.settings.set(key, value).catch((err: unknown) => log.warn('saving a Reviews setting failed', { key, err }))
}

interface ReviewStore {
  list: PrListData | null
  listError: PrError | null
  loading: boolean
  lastFetchAt: number | null
  /** The list is missing a PR an agent just opened; the next refresh goes whatever its reason. */
  stale: boolean
  visible: boolean
  selectedKey: string | null
  tab: ReviewTab
  filter: string
  /** A file the Files tab should open on, set when a conversation's path is clicked. */
  focusPath: string | null
  resources: Record<string, Partial<{ [K in TabResource]: Loadable<TabData[K]> }>>
  /** Chats linked to each PR, by `prKey`. Read from the local database, so cheap to re-read. */
  linkedChats: Record<string, PrLinkChat[]>
  /** Review context waiting for the user to pick a chat (none or several linked). */
  pendingAsk: ReviewContext | null
  /** Line comments held for the review, by `prKey`. */
  pendingComments: Record<string, PendingComment[]>
  /** A merge strategy the user picked from the menu, by `repoKey`, for this run of the app. Unset means the default (a merge commit). */
  mergeStrategy: Record<string, MergeStrategy>
  /** Settings `reviews.groupBy` and `reviews.collapsedRepos` (`repoKey`s). */
  groupBy: PrGroupBy
  collapsedRepos: string[]
  /** The "N hidden · Show" row was opened, for this visit. */
  showHidden: boolean
  /** Who Add reviewer offers, by `repoKey`, read once per run of the app. */
  candidates: Record<string, Loadable<PrReviewerCandidate[]>>
  hydrateSettings: () => Promise<void>
  setGroupBy: (groupBy: PrGroupBy) => void
  toggleRepo: (key: string) => void
  setShowHidden: (show: boolean) => void
  /** Hides or shows the PR in Reviews (local), then re-reads the list. Returns the reason when it failed. */
  setHidden: (ref: PrRef, hidden: boolean) => Promise<string | null>
  /** Hides repositories from Reviews (not read at all) or shows them again, then re-reads the list. Returns the reason when it failed. */
  setReposHidden: (repos: RepoRef[], hidden: boolean) => Promise<string | null>
  loadCandidates: (ref: PrRef) => Promise<void>
  setVisible: (visible: boolean) => void
  /** An agent opened a PR: re-read now when the list is on screen, else on the next open. */
  markStale: () => void
  setFilter: (filter: string) => void
  setTab: (tab: ReviewTab) => void
  openFile: (path: string) => void
  select: (key: string) => void
  /** `asHeader`: a chat header showing a linked PR reads the list on the same cadence as the open view. */
  refresh: (reason: PrRefreshReason, opts?: { asHeader?: boolean; keep?: string }) => Promise<void>
  loadLinkedChats: (ref: PrRef) => Promise<PrLinkChat[]>
  setPendingAsk: (ctx: ReviewContext | null) => void
  load: <K extends TabResource>(ref: PrRef, resource: K, opts?: { force?: boolean }) => Promise<void>
  addPendingComment: (ref: PrRef, comment: InlineCommentInput) => void
  removePendingComment: (ref: PrRef, id: string) => void
  /** Drops the first `count` pending comments (all by default): the ones a review posted. */
  dropPendingComments: (ref: PrRef, count?: number) => void
  setMergeStrategy: (ref: PrRef, strategy: MergeStrategy) => void
  /** Optimistic resolve: flips the thread in the loaded conversations now. */
  setConversationResolved: (ref: PrRef, id: string, resolved: boolean) => void
  /** After a write succeeded: re-read the PR's reads the write changed (and, not awaited, the list), keeping what is shown until they arrive. */
  afterWrite: (ref: PrRef, refresh: PrResource[]) => Promise<void>
}

const FETCHERS: { [K in TabResource]: (ref: PrRef) => Promise<PrResult<TabData[K]>> } = {
  detail: (ref) => window.api.pullRequests.detail(ref),
  files: (ref) => window.api.pullRequests.files(ref),
  conversations: (ref) => window.api.pullRequests.conversations(ref),
  checks: (ref) => window.api.pullRequests.checks(ref),
}

function toError(err: unknown): PrError {
  return { kind: 'unknown', host: null, message: err instanceof Error ? err.message : String(err) }
}

export function findSummary(list: PrListData | null, key: string | null): PrSummary | null {
  if (!list || !key) return null
  return list.prs.find((pr) => prKey(pr.ref) === key) ?? null
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  list: null,
  listError: null,
  loading: false,
  lastFetchAt: null,
  stale: false,
  visible: false,
  selectedKey: null,
  tab: 'overview',
  filter: '',
  focusPath: null,
  resources: {},
  linkedChats: {},
  pendingAsk: null,
  pendingComments: {},
  mergeStrategy: {},
  groupBy: 'status',
  collapsedRepos: [],
  showHidden: false,
  candidates: {},

  hydrateSettings: async () => {
    try {
      const [groupBy, collapsed] = await Promise.all([window.api.settings.get(GROUP_BY_KEY), window.api.settings.get(COLLAPSED_REPOS_KEY)])
      const list: unknown = collapsed ? JSON.parse(collapsed) : []
      set({
        groupBy: groupBy === 'repository' ? 'repository' : 'status',
        collapsedRepos: Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [],
      })
    } catch (err) {
      log.warn('reading Reviews settings failed', err)
    }
  },

  setGroupBy: (groupBy) => {
    set({ groupBy })
    persist(GROUP_BY_KEY, groupBy)
  },

  toggleRepo: (key) => {
    const collapsedRepos = toggleCollapsed(get().collapsedRepos, key)
    set({ collapsedRepos })
    persist(COLLAPSED_REPOS_KEY, JSON.stringify(collapsedRepos))
  },

  setShowHidden: (showHidden) => set({ showHidden }),

  setHidden: async (ref, hidden) => {
    let result: { ok: boolean; message?: string }
    try {
      result = hidden ? await window.api.pullRequests.hide(ref) : await window.api.pullRequests.unhide(ref)
    } catch (err) {
      log.warn('hiding a pull request failed', err)
      result = { ok: false, message: 'Could not save that; see the log.' }
    }
    if (!result.ok) return result.message ?? 'Could not save that.'
    // Mark it at once; the list read after confirms it.
    set((s) => {
      if (!s.list) return s
      const key = prKey(ref)
      // An older backend sends no `hidden`.
      const others = (s.list.hidden ?? []).filter((k) => k !== key)
      return { list: { ...s.list, hidden: hidden ? [...others, key] : others } }
    })
    await get().refresh('manual')
    return null
  },

  setReposHidden: async (repos, hidden) => {
    let result: { ok: boolean; message?: string }
    try {
      result = hidden ? await window.api.pullRequests.hideRepos(repos) : await window.api.pullRequests.unhideRepos(repos)
    } catch (err) {
      log.warn('hiding repositories failed', err)
      result = { ok: false, message: 'Could not save that; see the log.' }
    }
    if (!result.ok) return result.message ?? 'Could not save that.'
    // Move them at once; the list read after confirms it (a shown repository reappears with that read).
    const keys = new Set(repos.map(repoKey))
    set((s) => {
      if (!s.list) return s
      const others = (s.list.hiddenRepos ?? []).filter((r) => !keys.has(repoKey(r)))
      return {
        list: {
          ...s.list,
          sources: hidden ? s.list.sources.filter((src) => !keys.has(repoKey(src.repo))) : s.list.sources,
          hiddenRepos: hidden ? [...others, ...repos] : others,
        },
      }
    })
    await get().refresh('manual')
    return null
  },

  loadCandidates: async (ref) => {
    const key = repoKey(ref)
    const current = get().candidates[key]
    if (current && current.status !== 'error') return
    set((s) => ({ candidates: { ...s.candidates, [key]: { status: 'loading' } } }))
    let result: PrResult<PrReviewerCandidate[]>
    try {
      result = await window.api.pullRequests.reviewerCandidates(ref)
    } catch (err) {
      log.warn('reading reviewer candidates failed', err)
      result = { ok: false, error: toError(err) }
    }
    const next: Loadable<PrReviewerCandidate[]> = result.ok ? { status: 'ok', data: result.data, version: Date.now() } : { status: 'error', error: result.error }
    set((s) => ({ candidates: { ...s.candidates, [key]: next } }))
  },

  setVisible: (visible) => set({ visible }),

  markStale: () => {
    set({ stale: true })
    if (get().visible) void get().refresh('open')
  },
  setFilter: (filter) => set({ filter }),
  setTab: (tab) => set({ tab }),
  openFile: (path) => set({ tab: 'files', focusPath: path }),
  select: (key) => set((s) => (s.selectedKey === key ? s : { selectedKey: key, tab: 'overview', focusPath: null })),

  setPendingAsk: (pendingAsk) => set({ pendingAsk }),

  loadLinkedChats: async (ref) => {
    let chats: PrLinkChat[]
    try {
      chats = await window.api.pullRequests.linkedChats(ref)
    } catch (err) {
      log.warn('reading linked chats failed', err)
      chats = []
    }
    set((s) => ({ linkedChats: { ...s.linkedChats, [prKey(ref)]: chats } }))
    return chats
  },

  refresh: async (reason, opts = {}) => {
    const s = get()
    const visible = s.visible || opts.asHeader === true
    if (!shouldRefreshPullRequests({ lastFetchAt: s.lastFetchAt, inFlight: s.loading, visible, stale: s.stale }, reason, Date.now())) return
    set({ loading: true, lastFetchAt: Date.now(), stale: false })
    let result: PrResult<PrListData>
    try {
      result = await window.api.pullRequests.list()
    } catch (err) {
      log.warn('listing pull requests failed', err)
      result = { ok: false, error: toError(err) }
    }
    // A PR an agent opened while this read was in flight may be missing from it.
    if (get().stale && get().visible) queueMicrotask(() => void get().refresh('open'))
    const writtenKey = listAfterWrite
    listAfterWrite = null
    if (writtenKey !== null) queueMicrotask(() => void get().refresh('manual', { keep: writtenKey }))
    if (!result.ok) {
      // Still missing whatever made it stale; the next refresh goes whatever its reason.
      set({ loading: false, listError: result.error, stale: s.stale || get().stale })
      return
    }
    const previous = get().list
    const changed = new Set<string>()
    for (const pr of result.data.prs) {
      const before = findSummary(previous, prKey(pr.ref))
      if (before && pullRequestChanged(before, pr)) changed.add(prKey(pr.ref))
    }
    set((st) => {
      // A PR that changed on the host (edits, checks, conversations) loses its cached tabs,
      // except the one a write just changed, whose reads the writer re-reads in place.
      const resources = { ...st.resources }
      for (const key of changed) {
        if (key === opts.keep || key === writtenKey) continue
        for (const slot of [...loadTokens.keys()]) if (slot.startsWith(`${key}:`)) loadTokens.delete(slot)
        delete resources[key]
      }
      return { loading: false, listError: null, list: result.data, resources }
    })
    // Tabs of a changed PR reload when their view asks again; a manual refresh re-reads the open PR's tabs now.
    const selected = findSummary(result.data, get().selectedKey)
    if (selected && reason === 'manual' && prKey(selected.ref) !== opts.keep) {
      for (const resource of Object.keys(get().resources[prKey(selected.ref)] ?? {}) as TabResource[]) {
        void get().load(selected.ref, resource, { force: true })
      }
    }
  },

  load: async (ref, resource, opts = {}) => {
    const key = prKey(ref)
    const current = get().resources[key]?.[resource]
    if (current && !opts.force && current.status !== 'error') return
    const slot = `${key}:${resource}`
    const token = ++loadSeq
    loadTokens.set(slot, token)
    if (!current || current.status === 'error') {
      set((s) => ({ resources: { ...s.resources, [key]: { ...s.resources[key], [resource]: { status: 'loading' } } } }))
    }
    let result: PrResult<TabData[typeof resource]>
    try {
      result = await FETCHERS[resource](ref)
    } catch (err) {
      log.warn(`loading pull request ${resource} failed`, err)
      result = { ok: false, error: toError(err) }
    }
    const next: Loadable<TabData[typeof resource]> = result.ok
      ? { status: 'ok', data: result.data, version: Date.now() }
      : { status: 'error', error: result.error }
    if (loadTokens.get(slot) !== token) return
    loadTokens.delete(slot)
    set((s) => ({ resources: { ...s.resources, [key]: { ...s.resources[key], [resource]: next } } }))
  },

  addPendingComment: (ref, comment) => {
    const key = prKey(ref)
    const item: PendingComment = { ...comment, id: `pending-${++pendingSeq}` }
    set((s) => ({ pendingComments: { ...s.pendingComments, [key]: [...(s.pendingComments[key] ?? []), item] } }))
  },

  removePendingComment: (ref, id) => {
    const key = prKey(ref)
    set((s) => ({ pendingComments: { ...s.pendingComments, [key]: (s.pendingComments[key] ?? []).filter((c) => c.id !== id) } }))
  },

  dropPendingComments: (ref, count) => {
    const key = prKey(ref)
    set((s) => ({ pendingComments: { ...s.pendingComments, [key]: count === undefined ? [] : (s.pendingComments[key] ?? []).slice(count) } }))
  },

  setMergeStrategy: (ref, strategy) => set((s) => ({ mergeStrategy: { ...s.mergeStrategy, [repoKey(ref)]: strategy } })),

  setConversationResolved: (ref, id, resolved) => {
    const key = prKey(ref)
    set((s) => {
      const current = s.resources[key]?.conversations
      if (current?.status !== 'ok') return s
      const data = current.data.map((c) => (c.id === id ? { ...c, resolved } : c))
      return { resources: { ...s.resources, [key]: { ...s.resources[key], conversations: { ...current, data } } } }
    })
  },

  afterWrite: async (ref, refresh) => {
    const key = prKey(ref)
    // The list reads every repository (slow in a large Bitbucket workspace), so it
    // refreshes alongside; a control waits only for the PR it wrote to.
    if (get().loading) listAfterWrite = key
    else void get().refresh('manual', { keep: key })
    const loaded = get().resources[key] ?? {}
    await Promise.all(refresh.filter((r) => loaded[r] !== undefined).map((r) => get().load(ref, r, { force: true })))
  },
}))
