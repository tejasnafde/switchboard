/**
 * Read-only file viewer with Shiki syntax highlighting + scroll-to-line.
 *
 * Mounting cost is dominated by Shiki cold-start; we mitigate via the
 * module-level singleton in `services/shikiHighlighter.ts` so subsequent
 * mounts only pay grammar lookup time. Future: language-level lazy loading
 * if the eager bundle starts to weigh on bundle size.
 *
 * Selection capture: any user selection inside this component is rooted at
 * `[data-context-source="file-viewer"]`, so the global ⌘L handler can
 * route it through `contextBridge.captureSelection()` and append a
 * `@<path>:<start>-<end>` pill + code block to the active draft.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { useLayoutStore } from '../../stores/layout-store'
import { useAgentStore } from '../../stores/agent-store'
import { useThemeStore } from '../../stores/theme-store'
import { getHighlighter } from '../../services/shikiHighlighter'
import { InPaneSearchBar } from '../InPaneSearchBar'

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  css: 'css',
  html: 'html',
}

function detectLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

export const FileViewerPane = memo(function FileViewerPane(): React.ReactElement | null {
  const path = useLayoutStore((s) => s.viewerFilePath)
  const lineRange = useLayoutStore((s) => s.viewerLineRange)
  const treeCollapsed = useLayoutStore((s) => s.fileTreeCollapsed)
  const toggleTreeCollapsed = useLayoutStore((s) => s.toggleFileTreeCollapsed)
  const sessions = useAgentStore((s) => s.sessions)
  const activeId = useAgentStore((s) => s.activeSessionId)
  const repoRoot = sessions.find((s) => s.id === activeId)?.projectPath
  const theme = useThemeStore((s) => s.theme)

  const [content, setContent] = useState<string>('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string>('')
  // Markdown files default to rendered preview; users toggle to raw
  // when they want to see the underlying source / select raw text.
  // Per-mount default — no need to persist; viewer is short-lived.
  const [mdMode, setMdMode] = useState<'preview' | 'raw'>('preview')
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isMarkdown = useMemo(() => path?.toLowerCase().endsWith('.md') ?? false, [path])

  // ── In-pane ⌘F search ────────────────────────────────────────
  // Walks the rendered HTML container with a TreeWalker and wraps text
  // matches in <mark.sb-search-mark>. The current match scrolls into
  // view; ↑/↓ steps through. Pattern mirrors ChatPanel.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIdx, setSearchIdx] = useState(0)
  const [searchTotal, setSearchTotal] = useState(0)

  // Load file
  useEffect(() => {
    if (!repoRoot || !path) return
    let cancelled = false
    setError(null)
    setContent('')
    setHtml('')
    const api = window.api
    api?.files?.readFile(repoRoot, path)
      .then((res: { ok: boolean; error?: string; content: string; truncated: boolean }) => {
        if (cancelled) return
        if (!res.ok) {
          setError(res.error ?? 'Failed to read file')
          return
        }
        setContent(res.content)
        setTruncated(!!res.truncated)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
      })
    return () => { cancelled = true }
  }, [repoRoot, path])

  // Highlight (or markdown-render). The output is always raw HTML —
  // the renderer at the bottom drops it through `dangerouslySetInnerHTML`.
  // For .md in preview mode we run `marked` directly; otherwise we run
  // Shiki for syntax highlighting (raw markdown source uses lang=markdown).
  const lang = useMemo(() => (path ? detectLang(path) : 'plaintext'), [path])
  useEffect(() => {
    if (!content) { setHtml(''); return }
    let cancelled = false

    // Markdown preview path — bypass Shiki, render through marked.
    if (isMarkdown && mdMode === 'preview') {
      try {
        const md = marked.parse(content, { async: false }) as string
        if (!cancelled) setHtml(md)
      } catch {
        if (!cancelled) setHtml(`<pre>${content}</pre>`)
      }
      return () => { cancelled = true }
    }

    void (async () => {
      try {
        const hl = await getHighlighter()
        if (cancelled) return
        const themeName = theme === 'light' ? 'github-light' : 'github-dark'
        const out = hl.codeToHtml(content, { lang, theme: themeName })
        if (!cancelled) setHtml(out)
      } catch {
        // Fallback: render as plain pre/code so the pane is never blank.
        const escaped = content
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
        if (!cancelled) setHtml(`<pre><code>${escaped}</code></pre>`)
      }
    })()
    return () => { cancelled = true }
  }, [content, lang, theme, isMarkdown, mdMode])

  // Scroll to line range when present
  useEffect(() => {
    if (!html || !lineRange || !containerRef.current) return
    const lines = containerRef.current.querySelectorAll('.line')
    const target = lines.item(Math.max(0, lineRange.start - 1)) as HTMLElement | null
    if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [html, lineRange])

  const clearSearchMarks = useCallback(() => {
    const root = contentRef.current
    if (!root) return
    root.querySelectorAll('mark.sb-search-mark').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    })
  }, [])

  // Run search whenever query/html changes — wrap matches, count them.
  useEffect(() => {
    clearSearchMarks()
    if (!searchOpen || !searchQuery || !contentRef.current) {
      setSearchTotal(0)
      return
    }
    const root = contentRef.current
    const q = searchQuery.toLowerCase()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let n: Node | null = walker.nextNode()
    while (n) { textNodes.push(n as Text); n = walker.nextNode() }
    let total = 0
    for (const tn of textNodes) {
      const text = tn.nodeValue ?? ''
      const lower = text.toLowerCase()
      if (!lower.includes(q)) continue
      const frag = document.createDocumentFragment()
      let i = 0
      while (i < text.length) {
        const at = lower.indexOf(q, i)
        if (at === -1) {
          frag.appendChild(document.createTextNode(text.slice(i)))
          break
        }
        if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)))
        const mark = document.createElement('mark')
        mark.className = 'sb-search-mark'
        mark.textContent = text.slice(at, at + q.length)
        frag.appendChild(mark)
        i = at + q.length
        total += 1
      }
      tn.parentNode?.replaceChild(frag, tn)
    }
    setSearchTotal(total)
    setSearchIdx((idx) => total === 0 ? 0 : Math.min(idx, total - 1))
  }, [searchOpen, searchQuery, html, clearSearchMarks])

  // Scroll the active match into view + flag it visually.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const marks = root.querySelectorAll('mark.sb-search-mark')
    marks.forEach((m, i) => {
      ;(m as HTMLElement).style.outline = i === searchIdx ? '2px solid var(--accent)' : ''
    })
    const active = marks.item(searchIdx) as HTMLElement | null
    if (active) active.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [searchIdx, searchTotal])

  // ⌘F intercept — only when focus is inside this pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey && !e.ctrlKey
      const ctrl = e.ctrlKey && !e.metaKey
      if (!((cmd || ctrl) && !e.altKey && !e.shiftKey)) return
      if (e.key !== 'f' && e.key !== 'F') return
      const el = containerRef.current
      if (!el) return
      const active = document.activeElement as Element | null
      const inside = !!active && el.contains(active)
      if (!inside) return
      e.preventDefault()
      e.stopPropagation()
      setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchIdx(0)
    clearSearchMarks()
  }, [clearSearchMarks])

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

  return (
    <div
      ref={containerRef}
      data-context-source="file-viewer"
      data-file-path={path}
      tabIndex={-1}
      style={{
        height: '100%',
        // Outer is a flex column laying out [header][body] — the body owns
        // scrolling in BOTH axes so we don't double-scroll with the container.
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.5,
        background: 'var(--bg-primary)',
        position: 'relative',
        minWidth: 0,
      }}
    >
      {searchOpen && (
        <InPaneSearchBar
          onQuery={(q) => { setSearchQuery(q); setSearchIdx(0) }}
          onNext={() => setSearchIdx((i) => searchTotal === 0 ? 0 : (i + 1) % searchTotal)}
          onPrev={() => setSearchIdx((i) => searchTotal === 0 ? 0 : (i - 1 + searchTotal) % searchTotal)}
          onClose={handleSearchClose}
          matches={{ current: searchTotal === 0 ? 0 : searchIdx + 1, total: searchTotal }}
          placeholder="Find in file"
        />
      )}
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
          <div
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border)',
              borderRadius: 4,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => setMdMode('preview')}
              style={{
                background: mdMode === 'preview' ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-primary)',
                border: 'none',
                padding: '2px 8px',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Preview
            </button>
            <button
              type="button"
              onClick={() => setMdMode('raw')}
              style={{
                background: mdMode === 'raw' ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-primary)',
                border: 'none',
                borderLeft: '1px solid var(--border)',
                padding: '2px 8px',
                fontSize: 11,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Raw
            </button>
          </div>
        )}
        {truncated && <span style={{ color: 'var(--accent-warn, #d29922)' }}>truncated</span>}
      </div>
      {error ? (
        <div style={{ padding: 12, color: 'var(--accent-error, #f85149)' }}>
          {error}
        </div>
      ) : (
        <div
          ref={contentRef}
          className={isMarkdown && mdMode === 'preview' ? 'sb-file-viewer-md' : 'sb-file-viewer-code'}
          style={{
            // Body is the single scroll container — owns both axes. Code
            // mode keeps `pre` content as-is so long lines extend right and
            // the body's overflow-x scrollbar engages. Markdown preview
            // wraps, so it just needs vertical scroll.
            flex: '1 1 0',
            minHeight: 0,
            minWidth: 0,
            overflow: 'auto',
            padding: isMarkdown && mdMode === 'preview' ? '12px 16px' : '8px 0',
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
})
