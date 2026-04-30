/**
 * ⌘P fuzzy file finder. Lists every file in the active session's repo
 * (gitignored files included on purpose — user wants to peek at lockfiles,
 * build output, etc). Capped at 10k paths upstream so cold listings are
 * a few hundred ms at worst.
 *
 * Scoring: simple "all chars in order, prefer consecutive runs + matches
 * near the basename" fzf approximation. Good enough for ~10k items.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { fuzzyScore } from './fuzzyScore'

interface QuickOpenModalProps {
  open: boolean
  onClose: () => void
}

export function QuickOpenModal({ open, onClose }: QuickOpenModalProps): React.ReactElement | null {
  const sessions = useAgentStore((s) => s.sessions)
  const activeId = useAgentStore((s) => s.activeSessionId)
  const repoRoot = sessions.find((s) => s.id === activeId)?.projectPath ?? null
  const openInViewer = useLayoutStore((s) => s.openInViewer)

  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load the file list on open. Cache across reopens at the modal level
  // — if the user opens ⌘P twice in a row we reuse last cycle's listing.
  // Crude but effective; bust on session change.
  const cacheRef = useRef<{ repoRoot: string; files: string[] } | null>(null)
  useEffect(() => {
    if (!open || !repoRoot) return
    setQuery('')
    setActiveIdx(0)
    if (cacheRef.current?.repoRoot === repoRoot) {
      setFiles(cacheRef.current.files)
      return
    }
    setLoading(true)
    let cancelled = false
    void (async () => {
      try {
        const api = (window as any).api
        const res = await api?.files?.listAll(repoRoot)
        if (cancelled) return
        const list = res?.files ?? []
        cacheRef.current = { repoRoot, files: list }
        setFiles(list)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, repoRoot])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const results = useMemo(() => {
    if (!query) return files.slice(0, 100)
    const scored: { path: string; score: number }[] = []
    for (const f of files) {
      const s = fuzzyScore(query, f)
      if (s !== null) scored.push({ path: f, score: s })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 100).map((s) => s.path)
  }, [files, query])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  // Auto-scroll the active row into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  if (!open) return null

  const commit = (path: string) => {
    openInViewer(path)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '560px',
          maxWidth: '90%',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? 'Loading files…' : 'Type to find a file'}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActiveIdx((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const pick = results[activeIdx]
              if (pick) commit(pick)
            }
          }}
          style={{
            padding: '12px 14px',
            background: 'transparent',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-primary)',
            fontSize: '13px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <div ref={listRef} style={{ maxHeight: '50vh', overflowY: 'auto', padding: '4px 0' }}>
          {results.length === 0 && !loading && (
            <div style={{ padding: '12px 14px', color: 'var(--text-muted)', fontSize: 12 }}>
              {files.length === 0 ? 'No repo open.' : 'No matches.'}
            </div>
          )}
          {results.map((p, i) => {
            const slash = p.lastIndexOf('/')
            const dir = slash === -1 ? '' : p.slice(0, slash)
            const base = slash === -1 ? p : p.slice(slash + 1)
            const selected = i === activeIdx
            return (
              <div
                key={p}
                data-idx={i}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); commit(p) }}
                style={{
                  padding: '5px 14px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  background: selected ? 'var(--bg-hover)' : 'transparent',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  fontWeight: 500,
                }}>
                  {base}
                </span>
                {dir && (
                  <span style={{
                    color: 'var(--text-muted)',
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {dir}
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--border)',
          fontSize: 10.5,
          color: 'var(--text-muted)',
          display: 'flex',
          justifyContent: 'space-between',
        }}>
          <span>{loading ? 'loading…' : `${results.length}${files.length > results.length ? ` of ${files.length}` : ''}`}</span>
          <span>↑↓ navigate · Enter open · Esc close</span>
        </div>
      </div>
    </div>
  )
}
