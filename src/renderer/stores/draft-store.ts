import { create } from 'zustand'

const STORAGE_KEY = 'switchboard.drafts'
const PILLS_STORAGE_KEY = 'switchboard.draftPills'

/**
 * Stores unsent chat input per session, persisted to localStorage so
 * drafts survive app restarts. Two parallel structures:
 *
 *   - `drafts[sessionId]`: free-form typed text (the textarea contents)
 *   - `pillsBySession[sessionId]`: ordered list of structured pills (file
 *     viewer selections, terminal selections, chat-message quotes) — these
 *     render as Cursor-style chips above the textarea and serialize back
 *     into the message body when the user hits Send.
 */

export type DraftPillKind = 'file' | 'terminal' | 'chat-message'

export interface DraftPill {
  id: string
  kind: DraftPillKind
  /** Short display string shown on the chip (e.g. `cloudbuild.base.yaml (2-9)`). */
  label: string
  /** Full text inserted into the message body on Send. */
  content: string
}

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

function loadPills(): Record<string, DraftPill[]> {
  try {
    const raw = localStorage.getItem(PILLS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || !parsed) return {}
    return parsed
  } catch {
    return {}
  }
}

function savePills(pills: Record<string, DraftPill[]>) {
  try {
    localStorage.setItem(PILLS_STORAGE_KEY, JSON.stringify(pills))
  } catch { /* ignore */ }
}

interface DraftStore {
  drafts: Record<string, string>
  pillsBySession: Record<string, DraftPill[]>

  getDraft: (sessionId: string) => string
  setDraft: (sessionId: string, value: string) => void
  /**
   * Append to the target session's draft. Used by the "ask another agent"
   * forward action to hand a message off to a different session without
   * trampling whatever the user already typed there.
   */
  appendDraft: (sessionId: string, value: string) => void
  clearDraft: (sessionId: string) => void

  /** Pills (the visual chips above the textarea). */
  addPill: (sessionId: string, pill: DraftPill) => void
  removePill: (sessionId: string, pillId: string) => void
  clearPills: (sessionId: string) => void
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: loadDrafts(),
  pillsBySession: loadPills(),

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

  addPill: (sessionId, pill) =>
    set((state) => {
      const current = state.pillsBySession[sessionId] ?? []
      const next = { ...state.pillsBySession, [sessionId]: [...current, pill] }
      savePills(next)
      return { pillsBySession: next }
    }),

  removePill: (sessionId, pillId) =>
    set((state) => {
      const current = state.pillsBySession[sessionId] ?? []
      const filtered = current.filter((p) => p.id !== pillId)
      const next = { ...state.pillsBySession }
      if (filtered.length) next[sessionId] = filtered
      else delete next[sessionId]
      savePills(next)
      return { pillsBySession: next }
    }),

  clearPills: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.pillsBySession)) return state
      const next = { ...state.pillsBySession }
      delete next[sessionId]
      savePills(next)
      return { pillsBySession: next }
    }),
}))

/**
 * Serialize a list of pills back into a single string suitable for
 * prepending to the user's typed message before hitting the wire. Pure
 * function (input fully determines output) so the wire format stays
 * locked down under refactor.
 */
export function serializePillsForSend(pills: DraftPill[]): string {
  if (!pills.length) return ''
  return pills.map((p) => p.content.replace(/\s+$/g, '')).join('\n\n') + '\n\n'
}
