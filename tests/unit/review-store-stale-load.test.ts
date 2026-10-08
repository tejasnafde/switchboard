/**
 * A tab load that started before a refresh dropped its PR (the PR changed on
 * the host) must not write its stale answer back afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prKey,
  rollupChecks,
  type PrDetail,
  type PrListData,
  type PrResult,
  type PrSummary,
} from '../../src/shared/pull-requests'

const summary = (updatedAt: number): PrSummary => ({
  ref: { host: 'github', owner: 'o', name: 'r', number: 1 },
  title: 'PR',
  url: '',
  author: { login: 'a', displayName: 'a', avatarUrl: null },
  state: 'open',
  draft: false,
  sourceBranch: 'f',
  targetBranch: 'main',
  createdAt: 0,
  updatedAt,
  mergedAt: null,
  additions: null,
  deletions: null,
  changedFiles: null,
  unresolvedConversations: 0,
  checks: rollupChecks([]),
  reviewers: [],
  approvals: { given: 0, required: null },
  viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
  projectPaths: [],
})
const list = (updatedAt: number): PrListData => ({
  prs: [summary(updatedAt)],
  sources: [],
  unsupportedProjects: [],
  fetchedAt: 0,
})
const detail = (title: string, updatedAt: number): PrDetail => ({
  ...summary(updatedAt),
  title,
  description: '',
  headSha: null,
  mergeBlockers: [],
  activity: [],
  checkList: [],
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('review store tab loads', () => {
  it('drops a load that finishes after a refresh cleared its changed PR', async () => {
    let resolveOld!: (v: PrResult<PrDetail>) => void
    const detailCall = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PrResult<PrDetail>>((r) => {
            resolveOld = r
          }),
      )
      .mockImplementationOnce(async () => ({ ok: true, data: detail('fresh', 2) }))
    vi.stubGlobal('window', {
      api: { pullRequests: { list: async () => ({ ok: true, data: list(2) }), detail: detailCall } },
    })
    const { useReviewStore } = await import('../../src/renderer/stores/review-store')
    const ref = summary(1).ref
    const key = prKey(ref)
    useReviewStore.setState({ list: list(1), visible: true, lastFetchAt: null, loading: false, resources: {} })

    const old = useReviewStore.getState().load(ref, 'detail')
    await useReviewStore.getState().refresh('manual')
    expect(useReviewStore.getState().resources[key]).toBeUndefined()

    resolveOld({ ok: true, data: detail('stale', 1) })
    await old
    expect(useReviewStore.getState().resources[key]?.detail).toBeUndefined()

    // The view asks again and gets the fresh answer.
    await useReviewStore.getState().load(ref, 'detail')
    const fresh = useReviewStore.getState().resources[key]?.detail
    expect(fresh?.status === 'ok' && fresh.data.title).toBe('fresh')
  })
})
