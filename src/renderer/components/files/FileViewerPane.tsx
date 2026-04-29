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
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useLayoutStore } from '../../stores/layout-store'
import { useAgentStore } from '../../stores/agent-store'
import { useThemeStore } from '../../stores/theme-store'
import { getHighlighter } from '../../services/shikiHighlighter'

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
  const sessions = useAgentStore((s) => s.sessions)
  const activeId = useAgentStore((s) => s.activeSessionId)
  const repoRoot = sessions.find((s) => s.id === activeId)?.projectPath
  const theme = useThemeStore((s) => s.theme)

  const [content, setContent] = useState<string>('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [html, setHtml] = useState<string>('')
  const containerRef = useRef<HTMLDivElement>(null)

  // Load file
  useEffect(() => {
    if (!repoRoot || !path) return
    let cancelled = false
    setError(null)
    setContent('')
    setHtml('')
    const api = (window as any).api
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

  // Highlight
  const lang = useMemo(() => (path ? detectLang(path) : 'plaintext'), [path])
  useEffect(() => {
    if (!content) { setHtml(''); return }
    let cancelled = false
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
  }, [content, lang, theme])

  // Scroll to line range when present
  useEffect(() => {
    if (!html || !lineRange || !containerRef.current) return
    const lines = containerRef.current.querySelectorAll('.line')
    const target = lines.item(Math.max(0, lineRange.start - 1)) as HTMLElement | null
    if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [html, lineRange])

  if (!path) {
    return (
      <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>
        Click a file in the tree to view it.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-context-source="file-viewer"
      data-file-path={path}
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        lineHeight: 1.5,
        background: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          opacity: 0.7,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>{path}</span>
        {truncated && <span style={{ color: 'var(--accent-warn, #d29922)' }}>truncated</span>}
      </div>
      {error ? (
        <div style={{ padding: 12, color: 'var(--accent-error, #f85149)' }}>
          {error}
        </div>
      ) : (
        <div
          style={{ padding: '8px 0' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
})
