/**
 * Mounts a single CodeMirror EditorView per host instance and swaps in
 * the active buffer's state on bufferId change. The view is created
 * once and reused - `view.setState(buffer.state)` preserves cursor /
 * scroll / undo because each Buffer carries its own EditorState.
 *
 * On every doc-changing transaction, the view dispatches the new state
 * back to the editor-store via `setState(id, state)` - that's the
 * single seat of truth for dirty tracking and tab persistence.
 *
 * Theme + read-only changes propagate via Compartments without rebuilding
 * the state; the language pack also lives in a compartment so loading
 * `@codemirror/lang-typescript` for an opened TS file doesn't lose the
 * user's edits in flight.
 */
import { useEffect, useRef } from 'react'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { createRendererLogger } from '../../../logger'
import { useEditorStore } from '../../../stores/editor-store'

const log = createRendererLogger('editor:host')
import { useThemeStore } from '../../../stores/theme-store'
import { useLayoutStore } from '../../../stores/layout-store'
import {
  buildExtensions,
  languageCompartment,
  languageExtensionForPath,
  themeCompartment,
} from './extensions'
import { setHunksEffect } from './extensions/gitGutter'
import { cmdClickJump } from './extensions/cmdClickJump'
import { editorActionsKeymap } from './extensions/editorActions'
import { referencesPeek } from './extensions/referencesPeek'
import { themeFor } from './theme/highlightStyle'
import { lspChangeDoc, lspOpenDoc } from '../../../services/lspClient'

interface Props {
  bufferId: string | null
  /** Used to resolve save targets - passed verbatim to `files:write-file`. */
  repoRoot: string | null
}

export function EditorHost({ bufferId, repoRoot }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const mountedBufferRef = useRef<string | null>(null)
  // Full extension set, captured once so per-buffer setState swaps keep them.
  const extensionsRef = useRef<Extension[] | null>(null)
  // Buffers already rebuilt with the full extensions (openBuffer seeds []).
  const initializedRef = useRef<Set<string>>(new Set())
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
    // ⌘S / Ctrl+S - save active buffer. Prec.high so it beats CM6 defaults.
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
            const refreshGutter = (): void => {
              void window.api.git
                .fileDiff(root, buf.path)
                .then((diff) => {
                  if (mountedBufferRef.current !== id) return
                  if (diff.ok) view.dispatch({ effects: setHunksEffect.of(diff.hunks) })
                })
                .catch((err) => log.warn('post-save gutter refresh failed', err))
            }
            void (async () => {
              const res = await store.save(id, root, buf.path)
              if (res.ok) {
                refreshGutter()
                return
              }
              if (!res.conflict) {
                log.warn('save failed', res.error)
                return
              }
              // Changed on disk since open - let the user choose, don't drop it.
              const overwrite = window.confirm(
                `"${buf.path}" changed on disk since you opened it.\n\n` +
                  `OK = overwrite the disk version with your edits\n` +
                  `Cancel = reload from disk (discard your edits)`,
              )
              if (overwrite) {
                const forced = await store.save(id, root, buf.path, { force: true })
                if (forced.ok) refreshGutter()
                else log.warn('forced save failed', forced.error)
                return
              }
              // Reload from disk and re-sync the live view.
              const r = await window.api.files.readFile(root, buf.path)
              if (!r.ok) {
                log.warn('reload after conflict failed', r.error)
                return
              }
              store.reloadBuffer(id, r.content, r.mtimeMs)
              if (mountedBufferRef.current === id) {
                view.setState(
                  EditorState.create({ doc: r.content, extensions: extensionsRef.current ?? [] }),
                )
                initializedRef.current.add(id)
                useEditorStore.getState().setState(id, view.state)
                refreshGutter()
              }
            })().catch((err) => log.error('save threw', err))
            return true
          },
        },
      ]),
    )
    // The ⌘-click extension needs the live path of the currently mounted
    // buffer - we close over a ref so swapping tabs updates the lookup
    // without re-creating the view.
    const getPathForJump = (): string | null => {
      const id = mountedBufferRef.current
      if (!id) return null
      return useEditorStore.getState().buffers[id]?.path ?? null
    }
    const getRepoRootForJump = (): string | null => repoRootRef.current
    const fullExtensions: Extension[] = [
      saveKeymap,
      cmdClickJump(getPathForJump, getRepoRootForJump),
      editorActionsKeymap(getPathForJump, getRepoRootForJump),
      referencesPeek(),
      ...buildExtensions({ themeName: themeName as 'dark' | 'light' | 'translucent' }),
    ]
    extensionsRef.current = fullExtensions
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: '',
        extensions: fullExtensions,
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
      initializedRef.current.clear()
    }
  }, [])
  // Note: themeName intentionally NOT in deps - view persists; theme
  // updates via the dedicated effect below using a Compartment.

  // Swap the active buffer's state into the view when bufferId changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !bufferId) return
    const buf = useEditorStore.getState().buffers[bufferId]
    if (!buf) return
    if (mountedBufferRef.current === bufferId) return
    // Swap whole EditorStates (not a doc-replacing transaction) so each buffer
    // keeps its own undo history.
    mountedBufferRef.current = bufferId
    let target = buf.state
    if (!initializedRef.current.has(bufferId) && extensionsRef.current) {
      // openBuffer seeds extensions:[]; rebuild once with the real set.
      const anchor = Math.min(buf.state.selection.main.anchor, buf.state.doc.length)
      target = EditorState.create({
        doc: buf.state.doc,
        selection: { anchor },
        extensions: extensionsRef.current,
      })
      initializedRef.current.add(bufferId)
    }
    view.setState(target)
    // setState bypasses the dispatch override - round-trip to the store.
    useEditorStore.getState().setState(bufferId, view.state)
    // Focus on open/switch so focus-routed keys (⌘W, F12) hit the editor.
    view.focus()

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

  // Move the cursor + scroll the live view to the requested line range.
  const lineRange = useLayoutStore((s) => s.viewerLineRange)
  useEffect(() => {
    const view = viewRef.current
    if (!view || !lineRange) return
    const doc = view.state.doc
    const line = Math.max(1, Math.min(lineRange.start, doc.lines))
    const pos = doc.line(line).from
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    // Keep focus in the editor after a jump so editor-scoped keys (back-nav
    // Ctrl±, F12) keep working without an extra click.
    view.focus()
  }, [lineRange, bufferId])

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

  // Theme propagation via Compartment - no state rebuild.
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
