/**
 * Lazy-expanded directory tree for the right-pane "Files" mode.
 *
 * Each directory is a controlled `<details>`-style node that fetches its
 * children on first expand via `files:list-dir`. Gitignored entries are
 * rendered with `data-gitignored="true"` (CSS handles 50% opacity) but
 * remain clickable - VS Code style.
 *
 * Performance:
 *   - Children are loaded only when the directory expands; a subtree is
 *     never read until the user opens its parent. Idle file trees consume
 *     zero IPC.
 *   - Listings are cached in component state per absolute path; re-opening
 *     a folder we already loaded is instant.
 *   - We deliberately do NOT virtualize at this level - most repos have
 *     fewer than ~200 entries in any one dir, and adding react-virtual
 *     for that depth would dominate the perf budget. If we ever need it,
 *     swap the inner UL for a virtualizer.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('files:tree-pane')

interface DirEntry {
  name: string
  isDir: boolean
  isGitignored: boolean
}

interface NodeProps {
  repoRoot: string
  subPath: string
  name: string
  isGitignored: boolean
  depth: number
}

const FileNode = memo(function FileNode({ repoRoot, subPath, name, isGitignored, depth }: NodeProps) {
  const openInViewer = useLayoutStore((s) => s.openInViewer)
  return (
    <li
      data-gitignored={isGitignored ? 'true' : 'false'}
      onClick={() => openInViewer(subPath)}
      style={{
        cursor: 'pointer',
        padding: '2px 8px',
        paddingLeft: 8 + depth * 12,
        opacity: isGitignored ? 0.5 : 1,
        fontSize: 13,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      title={subPath}
    >
      <span style={{ marginRight: 4, opacity: 0.6 }}>•</span>
      {name}
    </li>
  )
})

interface DirNodeProps extends NodeProps {
  // Auto-expand the root.
  defaultOpen?: boolean
}

const DirNode = memo(function DirNode({ repoRoot, subPath, name, isGitignored, depth, defaultOpen }: DirNodeProps) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [entries, setEntries] = useState<DirEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (entries !== null || loading) return
    setLoading(true)
    try {
      const api = window.api
      const res = await api?.files?.listDir(repoRoot, subPath)
      if (res?.ok) {
        setEntries(res.entries as DirEntry[])
      } else {
        const msg = res?.error ?? 'unknown error'
        log.warn('listDir returned not-ok', { repoRoot, subPath, error: msg })
        setError(msg)
        setEntries([])
      }
    } catch (err) {
      log.warn('listDir threw', { repoRoot, subPath, err })
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [repoRoot, subPath, entries, loading])

  useEffect(() => {
    if (open) void load().catch((err) => log.warn('load() rejected', { subPath, err }))
  }, [open, load, subPath])

  return (
    <li
      data-gitignored={isGitignored ? 'true' : 'false'}
      style={{
        listStyle: 'none',
        opacity: isGitignored ? 0.5 : 1,
      }}
    >
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          cursor: 'pointer',
          padding: '2px 8px',
          paddingLeft: 8 + depth * 12,
          fontSize: 13,
          fontWeight: depth === 0 ? 600 : 500,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          userSelect: 'none',
        }}
        title={subPath || '/'}
      >
        <span style={{ marginRight: 4, display: 'inline-block', width: 10 }}>{open ? '▾' : '▸'}</span>
        {name}
      </div>
      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {loading && entries === null && (
            <li style={{ padding: '2px 8px', paddingLeft: 8 + (depth + 1) * 12, fontSize: 12, opacity: 0.5 }}>
              loading…
            </li>
          )}
          {error && (
            <li
              style={{ padding: '2px 8px', paddingLeft: 8 + (depth + 1) * 12, fontSize: 12, color: 'var(--error, #f85149)' }}
              title={error}
            >
              ⚠ couldn't read folder
            </li>
          )}
          {entries?.map((e) =>
            e.isDir ? (
              <DirNode
                key={e.name}
                repoRoot={repoRoot}
                subPath={subPath ? `${subPath}/${e.name}` : e.name}
                name={e.name}
                isGitignored={e.isGitignored}
                depth={depth + 1}
              />
            ) : (
              <FileNode
                key={e.name}
                repoRoot={repoRoot}
                subPath={subPath ? `${subPath}/${e.name}` : e.name}
                name={e.name}
                isGitignored={e.isGitignored}
                depth={depth + 1}
              />
            ),
          )}
        </ul>
      )}
    </li>
  )
})

export function FileTreePane(): React.ReactElement | null {
  // Select only the repo root (worktree-aware) rather than the whole sessions
  // array - otherwise the file tree re-rendered on every chat token.
  const repoRoot = useAgentStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    return session?.worktreePath ?? session?.projectPath
  })
  if (!repoRoot) {
    return (
      <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>
        Open a session to browse its files.
      </div>
    )
  }
  const rootName = repoRoot.split('/').filter(Boolean).pop() ?? repoRoot
  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        fontFamily: 'var(--font-sans)',
        background: 'var(--bg-primary)',
      }}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: '4px 0' }}>
        {/*
          Key by repoRoot so switching active session forces a fresh
          mount - otherwise React reuses the existing DirNode subtree
          and you keep seeing the previous project's cached entries.
        */}
        <DirNode
          key={repoRoot}
          repoRoot={repoRoot}
          subPath=""
          name={rootName}
          isGitignored={false}
          depth={0}
          defaultOpen
        />
      </ul>
    </div>
  )
}
