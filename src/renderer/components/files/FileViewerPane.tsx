/**
 * Right-pane file editor backed by CodeMirror 6. The pane:
 *   1. Resolves the active session's repo root and the current viewer
 *      path from `layout-store`.
 *   2. Reads the file via `files:read-file` (2 MB cap), opens (or
 *      reuses) a Buffer in `editor-store`.
 *   3. Mounts a single `<EditorHost>` keyed off the active buffer id.
 *
 * Markdown preview toggle: when `path` ends in `.md` AND mdMode='preview',
 * we render `marked` HTML in a sibling div and hide the editor. CM6 with
 * `lang-markdown` highlights raw markdown source — it doesn't render to
 * HTML, so preview is a separate code path. Switching to 'raw' shows the
 * editor again.
 *
 * Line-range scroll (from `viewerLineRange`): dispatched into the active
 * EditorView via a small effect after open. The editor owns scroll +
 * selection so this is a one-shot — subsequent navigation updates the
 * cursor / selection directly via `navigation/navigate.ts` (Phase 3).
 *
 * Selection capture: `data-context-source="file-viewer"` propagates from
 * `<EditorHost>`'s container so ⌘L / contextBridge still routes from
 * here without changes.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { useLayoutStore } from '../../stores/layout-store'
import { useAgentStore } from '../../stores/agent-store'
import { useEditorStore } from '../../stores/editor-store'
import { EditorHost } from './editor/EditorHost'
import { TabStrip } from './editor/TabStrip'

export const FileViewerPane = memo(function FileViewerPane(): React.ReactElement | null {
  const path = useLayoutStore((s) => s.viewerFilePath)
  const lineRange = useLayoutStore((s) => s.viewerLineRange)
  const treeCollapsed = useLayoutStore((s) => s.fileTreeCollapsed)
  const toggleTreeCollapsed = useLayoutStore((s) => s.toggleFileTreeCollapsed)
  const sessions = useAgentStore((s) => s.sessions)
  const activeId = useAgentStore((s) => s.activeSessionId)
  const session = sessions.find((s) => s.id === activeId)
  const repoRoot = session?.worktreePath ?? session?.projectPath ?? null

  const [mdPreview, setMdPreview] = useState<string>('')
  const [mdMode, setMdMode] = useState<'preview' | 'raw'>('preview')
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  // Derive from the store so TabStrip-initiated closes + focuses are
  // reflected here without a separate local state.
  const bufferId = useEditorStore((s) => (activeId ? (s.activeBySession[activeId] ?? null) : null))

  const isMarkdown = useMemo(() => path?.toLowerCase().endsWith('.md') ?? false, [path])

  // Load the file + open or reuse a Buffer in the editor-store.
  useEffect(() => {
    if (!repoRoot || !path || !activeId) {
      return
    }
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const res = await window.api.files.readFile(repoRoot, path)
        if (cancelled) return
        if (!res.ok) {
          setError(res.error ?? 'Failed to read file')
          return
        }
        setTruncated(!!res.truncated)
        // openBuffer is idempotent: returns existing id if already open.
        // It also sets activeBySession[activeId] = id, which updates our
        // store-derived `bufferId` above.
        useEditorStore.getState().openBuffer({
          sessionId: activeId,
          path,
          content: res.content,
          mtimeMs: res.mtimeMs,
        })
        if (isMarkdown) {
          try {
            setMdPreview(marked.parse(res.content, { async: false }) as string)
          } catch {
            setMdPreview('')
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoRoot, path, activeId, isMarkdown])

  // One-shot scroll to the requested line range after the buffer is mounted.
  // Editor owns scroll afterwards — this is just the entry-point hook.
  useEffect(() => {
    if (!bufferId || !lineRange) return
    // Defer to next tick so EditorHost's setState has landed.
    const t = setTimeout(() => {
      const buf = useEditorStore.getState().buffers[bufferId]
      if (!buf) return
      const line = Math.max(1, Math.min(lineRange.start, buf.state.doc.lines))
      const pos = buf.state.doc.line(line).from
      // Scroll via dispatching a transaction targeting the buffer's state.
      // EditorHost picks this up via setState seeing a new state object.
      const tr = buf.state.update({ selection: { anchor: pos } })
      useEditorStore.getState().setState(bufferId, tr.state)
    }, 0)
    return () => clearTimeout(t)
  }, [bufferId, lineRange])

  const handleToggleMdMode = useCallback(() => {
    setMdMode((m) => (m === 'preview' ? 'raw' : 'preview'))
  }, [])

  if (!path) {
    return (
      <div style={{ padding: 12, fontSize: 12, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 8 }}>
        {treeCollapsed && (
          <button
            type="button"
            onClick={toggleTreeCollapsed}
            title="Show file tree"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: 11,
              lineHeight: 1,
              borderRadius: 3,
            }}
          >
            ▶ Show tree
          </button>
        )}
        <span>Click a file in the tree to view it{treeCollapsed ? ', or ⌘P to quick-open.' : '.'}</span>
      </div>
    )
  }

  const showPreview = isMarkdown && mdMode === 'preview'

  return (
    <div
      data-file-path={path}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
        position: 'relative',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
      >
        {treeCollapsed && (
          <button
            type="button"
            onClick={toggleTreeCollapsed}
            title="Show file tree"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '0 4px',
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            ▶
          </button>
        )}
        <span style={{ opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {path}
        </span>
        {isMarkdown && (
          <button
            type="button"
            onClick={handleToggleMdMode}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-primary)',
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
              borderRadius: 4,
              fontFamily: 'inherit',
            }}
          >
            {mdMode === 'preview' ? 'Raw' : 'Preview'}
          </button>
        )}
        {truncated && <span style={{ color: 'var(--accent-warn, #d29922)' }}>truncated</span>}
      </div>
      {error ? (
        <div style={{ padding: 12, color: 'var(--accent-error, #f85149)' }}>{error}</div>
      ) : showPreview ? (
        <div
          className="sb-file-viewer-md"
          style={{
            flex: '1 1 0',
            minHeight: 0,
            minWidth: 0,
            overflow: 'auto',
            padding: '12px 16px',
            fontSize: 12,
            lineHeight: 1.6,
          }}
          dangerouslySetInnerHTML={{ __html: mdPreview }}
        />
      ) : (
        <div style={{ flex: '1 1 0', minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <TabStrip sessionId={activeId ?? null} />
          {bufferId === null ? (
            <div
              style={{
                flex: '1 1 0',
                minHeight: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                color: 'var(--text-muted)',
                opacity: 0.6,
              }}
            >
              Click a file in the tree to open it.
            </div>
          ) : (
            <div style={{ flex: '1 1 0', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
              <EditorHost bufferId={bufferId} repoRoot={repoRoot} />
            </div>
          )}
        </div>
      )}
    </div>
  )
})
