/**
 * An agent opened a PR: the Reviews list is stale until a read succeeds. A
 * read that fails keeps it stale, so the next open refreshes at once instead
 * of waiting for the 5 minute interval.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrListData, PrResult } from '../../src/shared/pull-requests'

const empty: PrListData = { prs: [], sources: [], unsupportedProjects: [], fetchedAt: 0, hidden: [], hiddenRepos: [] }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function store(answers: Array<PrResult<PrListData>>) {
  const list = vi.fn(async () => answers.shift() ?? { ok: true as const, data: empty })
  vi.stubGlobal('window', { api: { pullRequests: { list } } })
  const { useReviewStore } = await import('../../src/renderer/stores/review-store')
  return { useReviewStore, list }
}

describe('review store: a stale list', () => {
  it('stays stale when the refresh fails, and the next open reads again', async () => {
    const failed: PrResult<PrListData> = {
      ok: false,
      error: { kind: 'offline', host: 'github', message: 'Could not reach github.com.' },
    }
    const { useReviewStore, list } = await store([failed])
    useReviewStore.setState({ visible: true, lastFetchAt: Date.now(), loading: false, stale: false })

    useReviewStore.getState().markStale()
    await vi.waitFor(() => expect(useReviewStore.getState().loading).toBe(false))
    expect(list).toHaveBeenCalledTimes(1)
    expect(useReviewStore.getState().stale).toBe(true)

    // Within the interval an open would normally do nothing; a stale list reads.
    await useReviewStore.getState().refresh('open')
    expect(list).toHaveBeenCalledTimes(2)
    expect(useReviewStore.getState().stale).toBe(false)
  })

  it('is not stale after a failed ordinary refresh', async () => {
    const { useReviewStore } = await store([{ ok: false, error: { kind: 'offline', host: 'github', message: 'x' } }])
    useReviewStore.setState({ visible: true, lastFetchAt: null, loading: false, stale: false })
    await useReviewStore.getState().refresh('manual')
    expect(useReviewStore.getState().stale).toBe(false)
  })

  it('marks a hidden list stale without reading, and reads on the next open', async () => {
    const { useReviewStore, list } = await store([])
    useReviewStore.setState({ visible: false, lastFetchAt: Date.now(), loading: false, stale: false })
    useReviewStore.getState().markStale()
    expect(list).not.toHaveBeenCalled()
    useReviewStore.setState({ visible: true })
    await useReviewStore.getState().refresh('open')
    expect(list).toHaveBeenCalledTimes(1)
  })
})
