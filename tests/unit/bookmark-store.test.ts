import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBookmarkStore } from '../../src/renderer/stores/bookmark-store'
import type { Bookmark } from '../../src/shared/types'

// ── helpers ──────────────────────────────────────────────────────

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    save: vi.fn().mockResolvedValue({ ok: true }),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    list: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

function stubApi(bookmarks: ReturnType<typeof makeApi>) {
  vi.stubGlobal('window', { api: { bookmarks } })
}

const BASE_PARAMS = {
  sessionId: 's1',
  projectPath: '/repo',
  sessionTitle: 'Test session',
  agentType: 'claude-code',
  messageRole: 'assistant' as const,
  content: 'Hello world',
  messageTimestamp: 1000,
}

// ── suite ─────────────────────────────────────────────────────────

describe('bookmark-store', () => {
  beforeEach(() => {
    useBookmarkStore.setState({ bookmarks: [], keyToId: new Map() })
    stubApi(makeApi())
  })

  it('starts empty', () => {
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(0)
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(false)
  })

  it('save adds bookmark and isBookmarked returns true', async () => {
    await useBookmarkStore.getState().save(BASE_PARAMS)
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(true)
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(1)
    const b = useBookmarkStore.getState().bookmarks[0]
    expect(b.sessionId).toBe('s1')
    expect(b.messageTimestamp).toBe(1000)
    expect(b.contentExcerpt).toBe('Hello world')
  })

  it('save truncates contentExcerpt to 280 chars', async () => {
    const long = 'x'.repeat(400)
    await useBookmarkStore.getState().save({ ...BASE_PARAMS, content: long })
    const b = useBookmarkStore.getState().bookmarks[0]
    expect(b.contentExcerpt).toHaveLength(280)
  })

  it('idFor returns the bookmark id after save', async () => {
    await useBookmarkStore.getState().save(BASE_PARAMS)
    const id = useBookmarkStore.getState().idFor('s1', 1000)
    expect(id).toBeDefined()
    expect(id).toBe(useBookmarkStore.getState().bookmarks[0].id)
  })

  it('save is idempotent — second save is a no-op', async () => {
    const api = makeApi()
    stubApi(api)
    await useBookmarkStore.getState().save(BASE_PARAMS)
    await useBookmarkStore.getState().save(BASE_PARAMS)
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(1)
    expect(api.save).toHaveBeenCalledTimes(1)
  })

  it('remove deletes bookmark and isBookmarked returns false', async () => {
    await useBookmarkStore.getState().save(BASE_PARAMS)
    const id = useBookmarkStore.getState().idFor('s1', 1000)!
    await useBookmarkStore.getState().remove(id)
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(false)
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(0)
  })

  it('remove is a no-op for unknown id', async () => {
    await useBookmarkStore.getState().remove('nonexistent')
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(0)
  })

  it('save rolls back optimistically on API failure', async () => {
    stubApi(makeApi({ save: vi.fn().mockRejectedValue(new Error('net')) }))
    await useBookmarkStore.getState().save(BASE_PARAMS)
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(0)
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(false)
  })

  it('remove rolls back optimistically on API failure', async () => {
    // Save successfully first
    await useBookmarkStore.getState().save(BASE_PARAMS)
    const id = useBookmarkStore.getState().idFor('s1', 1000)!
    // Now make remove fail
    stubApi(makeApi({ remove: vi.fn().mockRejectedValue(new Error('net')) }))
    await useBookmarkStore.getState().remove(id)
    // Should be restored
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(1)
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(true)
  })

  it('load populates bookmarks from API', async () => {
    const existing: Bookmark = {
      id: 'b1', sessionId: 's2', projectPath: '/x', sessionTitle: 'X',
      agentType: 'codex', messageRole: 'user', contentExcerpt: 'hi',
      messageTimestamp: 500, savedAt: 9999,
    }
    stubApi(makeApi({ list: vi.fn().mockResolvedValue([existing]) }))
    await useBookmarkStore.getState().load()
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(1)
    expect(useBookmarkStore.getState().isBookmarked('s2', 500)).toBe(true)
    expect(useBookmarkStore.getState().idFor('s2', 500)).toBe('b1')
  })

  it('load is a no-op when api is unavailable', async () => {
    vi.stubGlobal('window', { api: {} })
    await expect(useBookmarkStore.getState().load()).resolves.toBeUndefined()
    expect(useBookmarkStore.getState().bookmarks).toHaveLength(0)
  })

  it('isBookmarked uses sessionId+timestamp as compound key', async () => {
    await useBookmarkStore.getState().save(BASE_PARAMS)
    // Same session, different timestamp → not bookmarked
    expect(useBookmarkStore.getState().isBookmarked('s1', 9999)).toBe(false)
    // Different session, same timestamp → not bookmarked
    expect(useBookmarkStore.getState().isBookmarked('other', 1000)).toBe(false)
    // Exact match → bookmarked
    expect(useBookmarkStore.getState().isBookmarked('s1', 1000)).toBe(true)
  })
})
