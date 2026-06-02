/**
 * Cursor-style per-file diff card rendered inline in the chat. One card per
 * file an agent changed during a turn (derived from a git checkpoint, so it
 * works for every provider). The user can keep or revert each hunk; on Apply
 * the resolved content is written back to disk.
 *
 * The diff math (build / accept-reject / reconstruct content) comes from the
 * unit-tested `fileDiffResolve` helpers, which wrap @pierre/diffs. Rendering
 * is a plain unified-diff view themed with our CSS variables (no shadow DOM)
 * so dark / light / translucent all flow through `theme-store`.
 */
import { useMemo, useState } from 'react'
import type { FileDiffAttachment } from '@shared/types'
import { createRendererLogger } from '../../logger'
import { buildFileDiff, hunkRows, applyHunkDecision, resolvedContent } from './fileDiffResolve'

const log = createRendererLogger('chat:file-diff-card')

export type FileDiffResolveStatus = 'accepted' | 'rejected' | 'partial'

interface Props {
  fileDiff: FileDiffAttachment
  /**
   * Called when the user decides. `contentToWrite` is the resolved file bytes
   * to write to disk, or null when no write is needed (kept as-is). The parent
   * persists the new status on the message.
   */
  onResolve?: (status: FileDiffResolveStatus, contentToWrite: string | null) => void
}

const KIND_LABEL: Record<FileDiffAttachment['changeKind'], string> = {
  add: 'added',
  modify: 'modified',
  delete: 'deleted',
}

export function FileDiffCard({ fileDiff, onResolve }: Props): React.ReactElement {
  const { relPath, oldContent, newContent, changeKind, status } = fileDiff

  // Build diff metadata once per (old,new). Guard against the degenerate
  // equal-content case (shouldn't happen — checkpoints only report changes).
  const metadata = useMemo(() => {
    try {
      return buildFileDiff(relPath, oldContent, newContent)
    } catch (err) {
      log.warn('failed to build file diff', { relPath, err })
      return null
    }
  }, [relPath, oldContent, newContent])

  // Per-hunk decision over ORIGINAL hunk indices. Default = keep the change.
  const [reverted, setReverted] = useState<Record<number, boolean>>({})
  const resolved = status !== 'pending'

  // Resolved cards start collapsed — decision is made, they're just history.
  // Pending cards start expanded so the user sees what needs reviewing.
  const [collapsed, setCollapsed] = useState(resolved)

  const hunkCount = metadata?.hunks.length ?? 0

  function computeResolved(reverts: Record<number, boolean>): { content: string; status: FileDiffResolveStatus } {
    if (!metadata) return { content: newContent, status: 'accepted' }
    const revertIndices = Object.keys(reverts)
      .filter((k) => reverts[Number(k)])
      .map(Number)
    if (revertIndices.length === 0) return { content: newContent, status: 'accepted' }
    // Apply reverts from highest hunk index down so collapsing a later hunk
    // doesn't shift the indices of earlier ones.
    let fd = metadata
    for (const i of revertIndices.sort((a, b) => b - a)) {
      fd = applyHunkDecision(fd, i, 'reject')
    }
    const content = resolvedContent(fd)
    const allReverted = revertIndices.length === hunkCount
    return { content, status: allReverted ? 'rejected' : 'partial' }
  }

  const apply = (reverts: Record<number, boolean>) => {
    const { content, status: s } = computeResolved(reverts)
    // Accepted = disk already holds newContent → no write needed (null).
    onResolve?.(s, s === 'accepted' ? null : content)
    setCollapsed(true)
  }

  const keepAll = () => apply({})
  const rejectAll = () => apply(Object.fromEntries(Array.from({ length: hunkCount }, (_, i) => [i, true])))
  const toggleHunk = (i: number) => setReverted((r) => ({ ...r, [i]: !r[i] }))

  return (
    <div
      data-context-source="chat-message"
      style={{
        width: '100%',
        border: '1px solid var(--border)',
        borderRadius: 8,
        margin: '6px 0',
        overflow: 'hidden',
        background: 'var(--bg-secondary)',
        fontSize: 12,
      }}
    >
      {/* Header — full row is clickable to toggle */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: collapsed ? '1px solid transparent' : '1px solid var(--border)',
          background: 'var(--bg-tertiary)',
          cursor: 'pointer',
          userSelect: 'none',
          transition: 'border-bottom-color 180ms ease',
        }}
      >
        <span style={{
          color: 'var(--text-muted)',
          fontSize: 10,
          width: 14,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 180ms cubic-bezier(0.4,0,0.2,1), color 180ms ease',
          transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
        }}>›</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{relPath}</span>
        <span style={{ opacity: 0.6 }}>{KIND_LABEL[changeKind]}</span>
        <span style={{ flex: 1 }} />
        {resolved ? (
          <StatusBadge status={status} />
        ) : (
          // stopPropagation so clicking a button doesn't also toggle collapse
          <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
            <button style={btnStyle} onClick={keepAll}>
              Keep all
            </button>
            <button style={btnStyle} onClick={rejectAll}>
              Reject all
            </button>
            {Object.values(reverted).some(Boolean) && (
              <button style={{ ...btnStyle, borderColor: 'var(--accent)', color: 'var(--accent)' }} onClick={() => apply(reverted)}>
                Apply
              </button>
            )}
          </div>
        )}
      </div>

      {/* Collapsible body — grid trick animates height without knowing it */}
      <div style={{
        display: 'grid',
        gridTemplateRows: collapsed ? '0fr' : '1fr',
        transition: 'grid-template-rows 200ms cubic-bezier(0.4,0,0.2,1)',
      }}>
        <div style={{ overflow: 'hidden' }}>
          {/* Hunks — bounded height with scroll so a large diff stays usable */}
          {metadata == null ? (
            <div style={{ padding: 10, opacity: 0.6 }}>Unable to render diff for this file.</div>
          ) : (
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {metadata.hunks.map((_, hunkIndex) => (
                <HunkBlock
                  key={hunkIndex}
                  rows={hunkRows(metadata, hunkIndex)}
                  reverted={!!reverted[hunkIndex]}
                  disabled={resolved}
                  onToggle={() => toggleHunk(hunkIndex)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: FileDiffAttachment['status'] }): React.ReactElement {
  const map: Record<string, { label: string; color: string }> = {
    accepted: { label: '✓ kept', color: 'var(--success, #2ea043)' },
    rejected: { label: '↩ reverted', color: 'var(--error, #f85149)' },
    partial: { label: '◐ partial', color: 'var(--accent)' },
    pending: { label: 'pending', color: 'var(--text-muted)' },
  }
  const { label, color } = map[status] ?? map.pending
  return <span style={{ color, fontWeight: 600 }}>{label}</span>
}

function HunkBlock({
  rows,
  reverted,
  disabled,
  onToggle,
}: {
  rows: ReturnType<typeof hunkRows>
  reverted: boolean
  disabled: boolean
  onToggle: () => void
}): React.ReactElement {
  return (
    <div style={{ opacity: reverted ? 0.45 : 1 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '2px 8px',
          background: 'var(--bg-primary)',
          borderTop: '1px solid var(--border)',
        }}
      >
        {!disabled && (
          <button style={miniBtnStyle} onClick={onToggle}>
            {reverted ? 'Undo revert' : 'Revert hunk'}
          </button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          lineHeight: 1.5,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {rows.map((row, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              background:
                row.kind === 'add'
                  ? 'var(--diff-add-bg, rgba(46,160,67,0.15))'
                  : row.kind === 'del'
                    ? 'var(--diff-del-bg, rgba(248,81,73,0.15))'
                    : 'transparent',
            }}
          >
            <span style={{ width: 18, textAlign: 'center', opacity: 0.7, userSelect: 'none', flexShrink: 0 }}>
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
            </span>
            <span style={{ padding: '0 8px' }}>{row.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
}

const miniBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 10,
  cursor: 'pointer',
}
