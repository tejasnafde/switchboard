import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { Bookmark } from '@shared/types'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:bookmarks')

function bookmarkKey(sessionId: string, messageTimestamp: number): string {
  return `${sessionId}:${messageTimestamp}`
}

interface BookmarkState {
  bookmarks: Bookmark[]
  keyToId: Map<string, string>

  load: () => Promise<void>
  save: (params: {
    sessionId: string
    projectPath: string
    sessionTitle: string
    agentType: string
    messageRole: 'user' | 'assistant'
    content: string
    messageTimestamp: number
  }) => Promise<void>
  remove: (id: string) => Promise<void>
  isBookmarked: (sessionId: string, messageTimestamp: number) => boolean
  idFor: (sessionId: string, messageTimestamp: number) => string | undefined
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  keyToId: new Map(),

  load: async () => {
    const api = window.api
    if (!api?.bookmarks?.list) return
    try {
      const rows = await api.bookmarks.list()
      const keyToId = new Map<string, string>()
      for (const b of rows) {
        keyToId.set(bookmarkKey(b.sessionId, b.messageTimestamp), b.id)
      }
      set({ bookmarks: rows, keyToId })
    } catch (err) {
      log.warn('load failed:', err)
    }
  },

  save: async ({ sessionId, projectPath, sessionTitle, agentType, messageRole, content, messageTimestamp }) => {
    const api = window.api
    if (!api?.bookmarks?.save) return
    // Deduplicate: silently skip if already saved
    if (get().isBookmarked(sessionId, messageTimestamp)) return
    const id = nanoid()
    const contentExcerpt = content.slice(0, 280)
    const savedAt = Date.now()
    const bookmark: Bookmark = {
      id, sessionId, projectPath, sessionTitle, agentType,
      messageRole, contentExcerpt, messageTimestamp, savedAt,
    }
    // Optimistic update
    set((s) => ({
      bookmarks: [bookmark, ...s.bookmarks],
      keyToId: new Map(s.keyToId).set(bookmarkKey(sessionId, messageTimestamp), id),
    }))
    try {
      await api.bookmarks.save({
        id, sessionId, projectPath, sessionTitle, agentType,
        messageRole, contentExcerpt, messageTimestamp,
      })
    } catch (err) {
      log.warn('save failed, rolling back:', err)
      set((s) => {
        const keyToId = new Map(s.keyToId)
        keyToId.delete(bookmarkKey(sessionId, messageTimestamp))
        return { bookmarks: s.bookmarks.filter((b) => b.id !== id), keyToId }
      })
    }
  },

  remove: async (id: string) => {
    const api = window.api
    const bookmark = get().bookmarks.find((b) => b.id === id)
    if (!bookmark) return
    // Optimistic update
    set((s) => {
      const keyToId = new Map(s.keyToId)
      keyToId.delete(bookmarkKey(bookmark.sessionId, bookmark.messageTimestamp))
      return { bookmarks: s.bookmarks.filter((b) => b.id !== id), keyToId }
    })
    try {
      await api?.bookmarks?.remove(id)
    } catch (err) {
      log.warn('remove failed, rolling back:', err)
      set((s) => ({
        bookmarks: [bookmark, ...s.bookmarks],
        keyToId: new Map(s.keyToId).set(
          bookmarkKey(bookmark.sessionId, bookmark.messageTimestamp), id,
        ),
      }))
    }
  },

  isBookmarked: (sessionId, messageTimestamp) =>
    get().keyToId.has(bookmarkKey(sessionId, messageTimestamp)),

  idFor: (sessionId, messageTimestamp) =>
    get().keyToId.get(bookmarkKey(sessionId, messageTimestamp)),
}))
