import { create } from 'zustand'

const STORAGE_KEY = 'switchboard.drafts'
const PILLS_STORAGE_KEY = 'switchboard.draftPills'

/**
 * Stores unsent chat input per session, persisted to localStorage so
 * drafts survive app restarts. Two parallel structures:
 *
 *   - `drafts[sessionId]`: free-form typed text (the textarea contents)
 *   - `pillsBySession[sessionId]`: ordered list of structured pills (file
 *     viewer selections, terminal selections, chat-message quotes) - these
 *     render as Cursor-style chips above the textarea and serialize back
 *     into the message body when the user hits Send.
 *   - `imagesBySession[sessionId]`: pasted/dropped image attachments. NOT
 *     persisted - each holds a live File and an object URL, neither of which
 *     survives JSON.stringify or a restart.
 */

export type DraftPillKind = 'file' | 'terminal' | 'chat-message'

/** A pasted, dropped or picked image waiting to be sent. */
export interface ImageAttachment {
  id: string
  file: File
  previewUrl: string
}

export interface DraftPill {
  id: string
  kind: DraftPillKind
  /** Short display string shown on the chip (e.g. `cloudbuild.base.yaml (2-9)`). */
  label: string
  /** Full text inserted into the message body on Send. */
  content: string
}

export interface DraftPayload {
  text: string
  pills: DraftPill[]
  images: ImageAttachment[]
}

export function draftPayloadEquals(left: DraftPayload, right: DraftPayload): boolean {
  if (left.text !== right.text || left.pills.length !== right.pills.length
    || left.images.length !== right.images.length) return false

  for (let index = 0; index < left.pills.length; index += 1) {
    const a = left.pills[index]
    const b = right.pills[index]
    if (a.id !== b.id || a.kind !== b.kind || a.label !== b.label || a.content !== b.content) {
      return false
    }
  }

  for (let index = 0; index < left.images.length; index += 1) {
    const a = left.images[index]
    const b = right.images[index]
    if (a.id !== b.id
      || a.file.name !== b.file.name
      || a.file.size !== b.file.size
      || a.file.type !== b.file.type
      || a.file.lastModified !== b.file.lastModified) return false
  }

  return true
}

export function discardDetachedDraftPayload(
  payload: DraftPayload,
  retainedPayloads: DraftPayload[] = [],
): void {
  const retainedUrls = new Set(
    retainedPayloads.flatMap((retained) => retained.images.map((image) => image.previewUrl)),
  )
  for (const image of payload.images) {
    if (!retainedUrls.has(image.previewUrl)) URL.revokeObjectURL(image.previewUrl)
  }
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
  } catch { /* quota exceeded or similar - ignore */ }
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
  imagesBySession: Record<string, ImageAttachment[]>

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

  addImages: (sessionId: string, images: ImageAttachment[]) => void
  removeImage: (sessionId: string, imageId: string) => void
  clearImages: (sessionId: string) => void
  replaceDraftPayload: (
    sessionId: string,
    payload: DraftPayload,
  ) => void
  detachDraftPayload: (sessionId: string) => DraftPayload | undefined
  restoreDraftPayloadIfEmpty: (sessionId: string, payload: DraftPayload) => boolean
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: loadDrafts(),
  pillsBySession: loadPills(),
  imagesBySession: {},

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

  addImages: (sessionId, images) =>
    set((state) => {
      const current = state.imagesBySession[sessionId] ?? []
      return { imagesBySession: { ...state.imagesBySession, [sessionId]: [...current, ...images] } }
    }),

  removeImage: (sessionId, imageId) =>
    set((state) => {
      const current = state.imagesBySession[sessionId] ?? []
      const target = current.find((i) => i.id === imageId)
      if (!target) return state
      URL.revokeObjectURL(target.previewUrl)
      const filtered = current.filter((i) => i.id !== imageId)
      const next = { ...state.imagesBySession }
      if (filtered.length) next[sessionId] = filtered
      else delete next[sessionId]
      return { imagesBySession: next }
    }),

  clearImages: (sessionId) =>
    set((state) => {
      const current = state.imagesBySession[sessionId]
      if (!current) return state
      for (const img of current) URL.revokeObjectURL(img.previewUrl)
      const next = { ...state.imagesBySession }
      delete next[sessionId]
      return { imagesBySession: next }
    }),

  replaceDraftPayload: (sessionId, payload) =>
    set((state) => {
      for (const image of state.imagesBySession[sessionId] ?? []) {
        if (!payload.images.some((replacement) => replacement.previewUrl === image.previewUrl)) {
          URL.revokeObjectURL(image.previewUrl)
        }
      }
      const drafts = { ...state.drafts }
      const pillsBySession = { ...state.pillsBySession }
      const imagesBySession = { ...state.imagesBySession }
      if (payload.text) drafts[sessionId] = payload.text
      else delete drafts[sessionId]
      if (payload.pills.length) pillsBySession[sessionId] = payload.pills
      else delete pillsBySession[sessionId]
      if (payload.images.length) imagesBySession[sessionId] = payload.images
      else delete imagesBySession[sessionId]
      saveDrafts(drafts)
      savePills(pillsBySession)
      return { drafts, pillsBySession, imagesBySession }
    }),

  detachDraftPayload: (sessionId) => {
    let detached: DraftPayload | undefined
    set((state) => {
      const text = state.drafts[sessionId] ?? ''
      const pills = state.pillsBySession[sessionId] ?? []
      const images = state.imagesBySession[sessionId] ?? []
      if (!text && pills.length === 0 && images.length === 0) return state

      detached = { text, pills, images }
      const drafts = { ...state.drafts }
      const pillsBySession = { ...state.pillsBySession }
      const imagesBySession = { ...state.imagesBySession }
      delete drafts[sessionId]
      delete pillsBySession[sessionId]
      delete imagesBySession[sessionId]
      saveDrafts(drafts)
      savePills(pillsBySession)
      return { drafts, pillsBySession, imagesBySession }
    })
    return detached
  },

  restoreDraftPayloadIfEmpty: (sessionId, payload) => {
    let restored = false
    set((state) => {
      if (state.drafts[sessionId]
        || state.pillsBySession[sessionId]?.length
        || state.imagesBySession[sessionId]?.length) return state

      restored = true
      const drafts = { ...state.drafts }
      const pillsBySession = { ...state.pillsBySession }
      const imagesBySession = { ...state.imagesBySession }
      if (payload.text) drafts[sessionId] = payload.text
      if (payload.pills.length) pillsBySession[sessionId] = payload.pills
      if (payload.images.length) imagesBySession[sessionId] = payload.images
      saveDrafts(drafts)
      savePills(pillsBySession)
      return { drafts, pillsBySession, imagesBySession }
    })
    return restored
  },
}))
