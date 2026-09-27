/**
 * Reviews view state: the pull request list, the selected PR and its tabs,
 * each tab's data loaded on first open and kept per PR until the list shows
 * that PR changed. When to refresh is decided by `shared/pull-request-refresh`.
 */
import { create } from 'zustand'
import { prKey, type PrChangedFile, type PrCheck, type PrConversation, type PrDetail, type PrError, type PrListData, type PrRef, type PrResult, type PrSummary } from '@shared/pull-requests'
import { pullRequestChanged, shouldRefreshPullRequests, type PrRefreshReason } from '@shared/pull-request-refresh'
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
export type TabResource = keyof TabData

interface ReviewStore {
  list: PrListData | null
  listError: PrError | null
  loading: boolean
  lastFetchAt: number | null
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
  setVisible: (visible: boolean) => void
  setFilter: (filter: string) => void
  setTab: (tab: ReviewTab) => void
  openFile: (path: string) => void
  select: (key: string) => void
  /** `asHeader`: a chat header showing a linked PR reads the list on the same cadence as the open view. */
  refresh: (reason: PrRefreshReason, opts?: { asHeader?: boolean }) => Promise<void>
  loadLinkedChats: (ref: PrRef) => Promise<PrLinkChat[]>
  setPendingAsk: (ctx: ReviewContext | null) => void
  load: <K extends TabResource>(ref: PrRef, resource: K, opts?: { force?: boolean }) => Promise<void>
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
  visible: false,
  selectedKey: null,
  tab: 'overview',
  filter: '',
  focusPath: null,
  resources: {},
  linkedChats: {},
  pendingAsk: null,

  setVisible: (visible) => set({ visible }),
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
    if (!shouldRefreshPullRequests({ lastFetchAt: s.lastFetchAt, inFlight: s.loading, visible }, reason, Date.now())) return
    set({ loading: true, lastFetchAt: Date.now() })
    let result: PrResult<PrListData>
    try {
      result = await window.api.pullRequests.list()
    } catch (err) {
      log.warn('listing pull requests failed', err)
      result = { ok: false, error: toError(err) }
    }
    if (!result.ok) {
      set({ loading: false, listError: result.error })
      return
    }
    const previous = get().list
    const changed = new Set<string>()
    for (const pr of result.data.prs) {
      const before = findSummary(previous, prKey(pr.ref))
      if (before && pullRequestChanged(before, pr)) changed.add(prKey(pr.ref))
    }
    set((st) => {
      // A PR that changed on the host (edits, checks, conversations) loses its cached tabs.
      const resources = { ...st.resources }
      for (const key of changed) {
        for (const slot of [...loadTokens.keys()]) if (slot.startsWith(`${key}:`)) loadTokens.delete(slot)
        delete resources[key]
      }
      return { loading: false, listError: null, list: result.data, resources }
    })
    // Tabs of a changed PR reload when their view asks again; a manual refresh re-reads the open PR's tabs now.
    const selected = findSummary(result.data, get().selectedKey)
    if (selected && reason === 'manual') {
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
}))
