/**
 * Multi-buffer / tab state for the right-pane file editor. Each Buffer
 * holds a CodeMirror EditorState so switching tabs is `view.setState(
 * buffer.state)` — O(1), preserves cursor + scroll + undo for free.
 *
 * The store is intentionally minimal: it owns the *map of buffers* and
 * the *per-session tab list / active id*. The actual EditorView lives
 * in `EditorHost.tsx` as a single ref-tracked instance — switching tabs
 * just dispatches a setState, never tearing down the view.
 *
 * Why per-session active + tabs? A user may have multiple chat sessions
 * pointing at the same project but be navigating different files in
 * each. Pinning the tab list to the session matches what they expect
 * when they switch sessions and back — their open files come with them.
 *
 * Buffer creation is *idempotent by path*: opening the same file twice
 * (e.g. clicking it in the file tree, then again from a chat pill)
 * returns the existing buffer rather than forking.
 */
import { create } from 'zustand'
import { EditorState, type Extension } from '@codemirror/state'
import {
  back as histBack,
  canBack,
  canForward,
  createHistoryStack,
  current as histCurrent,
  forward as histForward,
  push as histPush,
  type HistoryStack,
  type NavEntry,
} from '../components/files/editor/navigation/historyStack'

export interface Buffer {
  id: string
  path: string
  /** Absolute mtime of the on-disk file at last read. Used for save-conflict detection. */
  mtimeMs: number
  /** Content as last seen on disk (or last successful save). */
  savedDoc: string
  /** True when the in-memory doc has diverged from `savedDoc`. */
  dirty: boolean
  /** CodeMirror state — owns the doc, history, selection, language extensions. */
  state: EditorState
}

interface OpenBufferArgs {
  sessionId: string
  path: string
  content: string
  mtimeMs: number
  /** Optional CM6 extensions to seed the state with (theme, language, etc.). */
  extensions?: Extension[]
}

interface CloseOpts {
  force?: boolean
}

interface EditorStore {
  buffers: Record<string, Buffer>
  /** Per-session ordered list of buffer ids — drives the tab strip. */
  tabsBySession: Record<string, string[]>
  /** Per-session active buffer id (null = no tabs open in that session). */
  activeBySession: Record<string, string | null>
  /** Per-session back/forward navigation stack. */
  navBySession: Record<string, HistoryStack>

  openBuffer: (args: OpenBufferArgs) => string
  closeBuffer: (id: string, opts?: CloseOpts) => boolean
  focusBuffer: (id: string) => void
  markDirty: (id: string, dirty: boolean) => void
  /**
   * Push a navigation entry onto a session's history stack. Called by
   * jump-y code paths (file-tree click, ⌘P, ⌘-click definition, file
   * pill click). Coalesces same-path small-delta pushes.
   */
  pushNav: (sessionId: string, entry: NavEntry) => void
  navBack: (sessionId: string) => NavEntry | null
  navForward: (sessionId: string) => NavEntry | null
  canNavBack: (sessionId: string) => boolean
  canNavForward: (sessionId: string) => boolean
  /** Replace a buffer's CM state — called by the EditorView after edits. */
  setState: (id: string, state: EditorState) => void
  /** Mark a buffer as saved (clear dirty, update mtime + savedDoc). */
  markSaved: (id: string, savedDoc: string, mtimeMs: number) => void
  /**
   * Persist a buffer to disk. Returns the result so the caller can show
   * an inline error / conflict toast. The store knows the repoRoot via
   * the buffer's path resolution caller; we accept it explicitly so this
   * stays decoupled from agent-store / layout-store wiring.
   */
  save: (
    id: string,
    repoRoot: string,
    subPath: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; conflict?: boolean }>
}

let nextId = 1
function freshId(): string {
  return `buf_${nextId++}`
}

/** Find an existing buffer for `path` in the given session's tab list. */
function findBufferByPath(
  state: EditorStore,
  sessionId: string,
  path: string,
): string | undefined {
  const tabs = state.tabsBySession[sessionId] ?? []
  return tabs.find((id) => state.buffers[id]?.path === path)
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  buffers: {},
  tabsBySession: {},
  activeBySession: {},
  navBySession: {},

  openBuffer: ({ sessionId, path, content, mtimeMs, extensions = [] }) => {
    const existing = findBufferByPath(get(), sessionId, path)
    if (existing) {
      // Already open — just focus.
      set((s) => ({ activeBySession: { ...s.activeBySession, [sessionId]: existing } }))
      return existing
    }
    const id = freshId()
    const buffer: Buffer = {
      id,
      path,
      mtimeMs,
      savedDoc: content,
      dirty: false,
      state: EditorState.create({ doc: content, extensions }),
    }
    set((s) => ({
      buffers: { ...s.buffers, [id]: buffer },
      tabsBySession: {
        ...s.tabsBySession,
        [sessionId]: [...(s.tabsBySession[sessionId] ?? []), id],
      },
      activeBySession: { ...s.activeBySession, [sessionId]: id },
    }))
    return id
  },

  closeBuffer: (id, opts) => {
    const state = get()
    const buf = state.buffers[id]
    if (!buf) return false
    if (buf.dirty && !opts?.force) return false

    // Find the session(s) that have this buffer in their tab list.
    const newTabsBySession: Record<string, string[]> = { ...state.tabsBySession }
    const newActive: Record<string, string | null> = { ...state.activeBySession }
    for (const [sid, tabs] of Object.entries(state.tabsBySession)) {
      const idx = tabs.indexOf(id)
      if (idx === -1) continue
      const next = tabs.filter((t) => t !== id)
      newTabsBySession[sid] = next
      if (state.activeBySession[sid] === id) {
        // Promote: prefer the tab to the right; fall back to the left;
        // null if none remain.
        const promoted = next[idx] ?? next[idx - 1] ?? null
        newActive[sid] = promoted
      }
    }

    const newBuffers = { ...state.buffers }
    delete newBuffers[id]
    set({ buffers: newBuffers, tabsBySession: newTabsBySession, activeBySession: newActive })
    return true
  },

  focusBuffer: (id) => {
    const state = get()
    const buf = state.buffers[id]
    if (!buf) return
    // Locate which session owns this buffer (first hit wins; buffer ids
    // are unique across sessions because we mint them globally).
    const owner = Object.entries(state.tabsBySession).find(([, tabs]) => tabs.includes(id))?.[0]
    if (!owner) return
    set((s) => ({ activeBySession: { ...s.activeBySession, [owner]: id } }))
  },

  markDirty: (id, dirty) => {
    set((s) => {
      const buf = s.buffers[id]
      if (!buf) return s
      return { buffers: { ...s.buffers, [id]: { ...buf, dirty } } }
    })
  },

  setState: (id, state) => {
    set((s) => {
      const buf = s.buffers[id]
      if (!buf) return s
      const dirty = state.doc.toString() !== buf.savedDoc
      return { buffers: { ...s.buffers, [id]: { ...buf, state, dirty } } }
    })
  },

  markSaved: (id, savedDoc, mtimeMs) => {
    set((s) => {
      const buf = s.buffers[id]
      if (!buf) return s
      return { buffers: { ...s.buffers, [id]: { ...buf, savedDoc, mtimeMs, dirty: false } } }
    })
  },

  pushNav: (sessionId, entry) => {
    set((s) => {
      const stack = s.navBySession[sessionId] ?? createHistoryStack()
      return { navBySession: { ...s.navBySession, [sessionId]: histPush(stack, entry) } }
    })
  },

  navBack: (sessionId) => {
    const stack = get().navBySession[sessionId]
    if (!stack || !canBack(stack)) return null
    const next = histBack(stack)
    set((s) => ({ navBySession: { ...s.navBySession, [sessionId]: next } }))
    return histCurrent(next)
  },

  navForward: (sessionId) => {
    const stack = get().navBySession[sessionId]
    if (!stack || !canForward(stack)) return null
    const next = histForward(stack)
    set((s) => ({ navBySession: { ...s.navBySession, [sessionId]: next } }))
    return histCurrent(next)
  },

  canNavBack: (sessionId) => {
    const stack = get().navBySession[sessionId]
    return !!stack && canBack(stack)
  },

  canNavForward: (sessionId) => {
    const stack = get().navBySession[sessionId]
    return !!stack && canForward(stack)
  },

  save: async (id, repoRoot, subPath) => {
    const buf = get().buffers[id]
    if (!buf) return { ok: false, error: 'Buffer not found' }
    const content = buf.state.doc.toString()
    const res = await window.api.files.writeFile(repoRoot, subPath, content, buf.mtimeMs)
    if (res.ok) {
      get().markSaved(id, content, res.mtimeMs)
      return { ok: true }
    }
    return { ok: false, error: res.error, conflict: res.conflict }
  },
}))
