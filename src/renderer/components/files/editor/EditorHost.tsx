/**
 * Mounts a single CodeMirror EditorView per host instance and swaps in
 * the active buffer's state on bufferId change. The view is created
 * once and reused — `view.setState(buffer.state)` preserves cursor /
 * scroll / undo because each Buffer carries its own EditorState.
 *
 * On every doc-changing transaction, the view dispatches the new state
 * back to the editor-store via `setState(id, state)` — that's the
 * single seat of truth for dirty tracking and tab persistence.
 *
 * Theme + read-only changes propagate via Compartments without rebuilding
 * the state; the language pack also lives in a compartment so loading
 * `@codemirror/lang-typescript` for an opened TS file doesn't lose the
 * user's edits in flight.
 */
import { useEffect, useRef } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { createRendererLogger } from '../../../logger'
import { useEditorStore } from '../../../stores/editor-store'

const log = createRendererLogger('editor:host')
import { useThemeStore } from '../../../stores/theme-store'
import {
  buildExtensions,
  languageCompartment,
  languageExtensionForPath,
  themeCompartment,
} from './extensions'
import { setHunksEffect } from './extensions/gitGutter'
import { cmdClickJump } from './extensions/cmdClickJump'
import { themeFor } from './theme/highlightStyle'
import { lspChangeDoc, lspOpenDoc } from '../../../services/lspClient'

interface Props {
  bufferId: string | null
  /** Used to resolve save targets — passed verbatim to `files:write-file`. */
  repoRoot: string | null
}

export function EditorHost({ bufferId, repoRoot }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const mountedBufferRef = useRef<string | null>(null)
  const themeName = useThemeStore((s) => s.theme)

  // Stash the latest repoRoot in a ref so the save keymap (closed over
  // at view-construction time) reads the live value, not the stale one.
  const repoRootRef = useRef(repoRoot)
  useEffect(() => {
    repoRootRef.current = repoRoot
  }, [repoRoot])

  // Construct the EditorView exactly once per mount.
  useEffect(() => {
    if (!containerRef.current || viewRef.current) return
    // ⌘S / Ctrl+S — save active buffer. Prec.high so it beats CM6 defaults.
    const saveKeymap = Prec.high(
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            const id = mountedBufferRef.current
            const root = repoRootRef.current
            if (!id || !root) return false
            const store = useEditorStore.getState()
            const buf = store.buffers[id]
            if (!buf) return false
            void store
              .save(id, root, buf.path)
              .then((res) => {
                if (!res.ok) {
                  log.warn('save failed', res.error, res.conflict ? '(conflict)' : '')
                  return
                }
                // Refresh gutter after a successful save.
                void window.api.git
                  .fileDiff(root, buf.path)
                  .then((diff) => {
                    if (mountedBufferRef.current !== id) return
                    if (diff.ok) view.dispatch({ effects: setHunksEffect.of(diff.hunks) })
                  })
                  .catch((err) => log.warn('post-save gutter refresh failed', err))
              })
              .catch((err) => log.error('save threw', err))
            return true
          },
        },
      ]),
    )
    // The ⌘-click extension needs the live path of the currently mounted
    // buffer — we close over a ref so swapping tabs updates the lookup
    // without re-creating the view.
    const getPathForJump = (): string | null => {
      const id = mountedBufferRef.current
      if (!id) return null
      return useEditorStore.getState().buffers[id]?.path ?? null
    }
    const getRepoRootForJump = (): string | null => repoRootRef.current
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          saveKeymap,
          cmdClickJump(getPathForJump, getRepoRootForJump),
          ...buildExtensions({ themeName: themeName as 'dark' | 'light' | 'translucent' }),
        ],
      }),
      dispatch: (tr) => {
        view.update([tr])
        // Round-trip every state change back to the store. Cheap; lets
        // dirty tracking be a doc-content diff in `setState`.
        const id = mountedBufferRef.current
        if (id) useEditorStore.getState().setState(id, view.state)
      },
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
      // Clear the marker so a recreated view (StrictMode remount, md
      // preview/raw toggle) re-runs the swap below instead of rendering blank.
      mountedBufferRef.current = null
    }
  }, [])
  // Note: themeName intentionally NOT in deps — view persists; theme
  // updates via the dedicated effect below using a Compartment.

  // Swap the active buffer's state into the view when bufferId changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !bufferId) return
    const buf = useEditorStore.getState().buffers[bufferId]
    if (!buf) return
    if (mountedBufferRef.current === bufferId) return
    // Dispatch instead of setState — preserves the view's extension
    // configuration (buffers are created with extensions: []).
    const newDoc = buf.state.doc.toString()
    const anchor = Math.min(buf.state.selection.main.anchor, newDoc.length)
    // Set the marker BEFORE dispatching: the dispatch override round-trips
    // view.state into mountedBufferRef's buffer, so a stale marker here would
    // write the new file's content over the previous buffer.
    mountedBufferRef.current = bufferId
    view.dispatch(
      view.state.update({
        changes: { from: 0, to: view.state.doc.length, insert: newDoc },
        selection: { anchor },
        scrollIntoView: true,
      }),
    )

    // Lazily attach the right language pack (after the swap so the
    // user sees content immediately even on first-load of a lang).
    void languageExtensionForPath(buf.path).then((ext) => {
      if (mountedBufferRef.current !== bufferId) return
      view.dispatch({ effects: languageCompartment.reconfigure(ext) })
    })

    // Fetch git hunks for the gutter. Best-effort; errors / non-git
    // dirs just leave the gutter empty.
    if (repoRoot) {
      void window.api.git
        .fileDiff(repoRoot, buf.path)
        .then((res) => {
          if (mountedBufferRef.current !== bufferId) return
          if (res.ok) view.dispatch({ effects: setHunksEffect.of(res.hunks) })
        })
        .catch((err) => log.warn('git gutter diff failed', { path: buf.path, err }))
    }

    // didOpen against the LSP. We pass the absolute path; LSP servers
    // fail silently for unsupported languages (Rust/Go etc.).
    if (repoRoot) {
      const abs = `${repoRoot}/${buf.path}`.replace(/\/+/g, '/')
      void lspOpenDoc(repoRoot, abs, buf.state.doc.toString()).catch((err) =>
        log.warn('lsp didOpen failed', { path: buf.path, err }),
      )
    }
  }, [bufferId, repoRoot])

  // Debounced didChange: 300ms after the last edit, send the latest
  // doc to the LSP. We subscribe to the buffer's `state` slot at the
  // top level so the effect re-runs whenever it changes.
  const bufState = useEditorStore((s) => (bufferId ? s.buffers[bufferId]?.state ?? null : null))
  useEffect(() => {
    if (!bufferId || !repoRoot || !bufState) return
    const timeout = setTimeout(() => {
      const buf = useEditorStore.getState().buffers[bufferId]
      if (!buf) return
      const abs = `${repoRoot}/${buf.path}`.replace(/\/+/g, '/')
      void lspChangeDoc(repoRoot, abs, buf.state.doc.toString()).catch((err) =>
        log.warn('lsp didChange failed', { path: buf.path, err }),
      )
    }, 300)
    return () => clearTimeout(timeout)
  }, [bufferId, repoRoot, bufState])

  // Theme propagation via Compartment — no state rebuild.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.reconfigure(themeFor(themeName as 'dark' | 'light' | 'translucent')),
    })
  }, [themeName])

  return (
    <div
      ref={containerRef}
      data-context-source="file-viewer"
      style={{ height: '100%', width: '100%', overflow: 'hidden' }}
    />
  )
}
