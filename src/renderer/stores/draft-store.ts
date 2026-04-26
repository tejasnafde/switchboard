import { create } from 'zustand'

const STORAGE_KEY = 'switchboard.drafts'

/**
 * Stores unsent chat input per session, persisted to localStorage
 * so drafts survive app restarts.
 */

function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || !parsed) return {}
    return parsed
  } catch {
    return {}
  }
}

function saveDrafts(drafts: Record<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch { /* quota exceeded or similar — ignore */ }
}

interface DraftStore {
  drafts: Record<string, string>
  getDraft: (sessionId: string) => string
  setDraft: (sessionId: string, value: string) => void
  /**
   * Append to the target session's draft. Used by the "ask another agent"
   * forward action to hand a message off to a different session without
   * trampling whatever the user already typed there.
   */
  appendDraft: (sessionId: string, value: string) => void
  clearDraft: (sessionId: string) => void
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: loadDrafts(),

  getDraft: (sessionId) => get().drafts[sessionId] ?? '',

  setDraft: (sessionId, value) =>
    set((state) => {
      const next = { ...state.drafts }
      if (value) {
        next[sessionId] = value
      } else {
        delete next[sessionId]
      }
      saveDrafts(next)
      return { drafts: next }
    }),

  appendDraft: (sessionId, value) =>
    set((state) => {
      const current = state.drafts[sessionId] ?? ''
      const sep = current && !current.endsWith('\n\n') ? '\n\n' : ''
      const next = { ...state.drafts, [sessionId]: current + sep + value }
      saveDrafts(next)
      return { drafts: next }
    }),

  clearDraft: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.drafts)) return state
      const next = { ...state.drafts }
      delete next[sessionId]
      saveDrafts(next)
      return { drafts: next }
    }),
}))
