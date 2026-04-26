import { useState } from 'react'
import type { ChatMessage } from '@shared/types'

interface ApprovalCardProps {
  message: ChatMessage
  onDecide: (requestId: string, decision: 'approve' | 'deny', note?: string) => void
}

/**
 * Approval UI for tool permission requests.
 *
 * Supports four actions:
 *   - Approve
 *   - Deny
 *   - Approve & add note ("Yes, and also do X")
 *   - Deny & add note ("No, do Y instead")
 *
 * The note is sent as a user message alongside the decision so the agent
 * sees extra context on the next turn.
 */
export function ApprovalCard({ message, onDecide }: ApprovalCardProps) {
  const [noteMode, setNoteMode] = useState<null | 'approve' | 'deny'>(null)
  const [note, setNote] = useState('')

  if (!message.approval) return null

  const reqId = message.id.replace('approval_', '')
  const pending = message.approval.status === 'pending'
  const accepted = message.approval.status === 'accepted'

  const title = pending ? 'Approval needed' : accepted ? 'Approved' : 'Rejected'
  const accentColor = pending ? 'var(--warning)' : accepted ? 'var(--success)' : 'var(--error)'
  const borderColor = pending ? 'var(--warning)' : 'var(--border)'
  const bgTint = pending
    ? 'rgba(210, 153, 34, 0.06)'
    : accepted
      ? 'rgba(63, 185, 80, 0.05)'
      : 'rgba(248, 81, 73, 0.05)'

  const commit = (decision: 'approve' | 'deny') => {
    const trimmed = note.trim()
    onDecide(reqId, decision, trimmed || undefined)
    setNoteMode(null)
    setNote('')
  }

  return (
    <div
      style={{
        marginTop: '8px',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius)',
        background: bgTint,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderBottom: pending ? `1px solid ${borderColor}` : 'none',
      }}>
        <ShieldIcon />
        <span style={{
          fontSize: '11px',
          fontWeight: 600,
          color: accentColor,
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
        }}>
          {title}
        </span>
        <span style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }} title={message.approval.toolName}>
          {message.approval.toolName}
        </span>
      </div>

      {/* Detail — collapsible. Long JSON tool inputs used to overflow a
          160px box silently; now default-collapsed with a summary line. */}
      <ApprovalDetail detail={message.approval.detail} />


      {/* Action bar */}
      {pending && (
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          borderTop: `1px solid ${borderColor}`,
        }}>
          {noteMode ? (
            <>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {noteMode === 'approve' ? 'Approve and add context:' : 'Deny and tell agent what to do instead:'}
              </div>
              <textarea
                value={note}
                autoFocus
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    commit(noteMode)
                  }
                  if (e.key === 'Escape') {
                    setNoteMode(null)
                    setNote('')
                  }
                }}
                placeholder={noteMode === 'approve' ? 'e.g. "and also update the tests"' : 'e.g. "don\'t touch the config file, do X instead"'}
                rows={2}
                style={{
                  width: '100%',
                  resize: 'vertical',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                  fontFamily: 'var(--font-sans)',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { setNoteMode(null); setNote('') }}
                  style={btnStyles.ghost}
                >
                  Cancel
                </button>
                <button
                  onClick={() => commit(noteMode)}
                  style={noteMode === 'approve' ? btnStyles.primary : btnStyles.danger}
                >
                  {noteMode === 'approve' ? 'Approve with note' : 'Deny with note'}
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button
                onClick={() => commit('approve')}
                style={btnStyles.primary}
              >
                <CheckIcon /> Approve
              </button>
              <button
                onClick={() => setNoteMode('approve')}
                style={btnStyles.secondary}
                title="Approve and add extra instructions"
              >
                {'Yes, and\u2026'}
              </button>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setNoteMode('deny')}
                style={btnStyles.secondary}
                title="Deny and tell agent what to do instead"
              >
                {'No, do\u2026'}
              </button>
              <button
                onClick={() => commit('deny')}
                style={btnStyles.danger}
              >
                <XIcon /> Deny
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Icons ─────────────────────────────────────────────────────

function ShieldIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--warning)', flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '2px' }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '2px' }}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// ─── Button styles ─────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  padding: '5px 12px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '11.5px',
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  transition: 'filter 0.1s, background 0.1s',
}

const btnStyles: Record<string, React.CSSProperties> = {
  primary: {
    ...btnBase,
    background: 'var(--success)',
    color: '#fff',
    border: '1px solid var(--success)',
    fontWeight: 600,
  },
  danger: {
    ...btnBase,
    background: 'var(--error)',
    color: '#fff',
    border: '1px solid var(--error)',
    fontWeight: 600,
  },
  secondary: {
    ...btnBase,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
  },
  ghost: {
    ...btnBase,
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
  },
}

/**
 * Collapsible tool-input detail. Long JSON used to overflow a 160px
 * scrolling box silently — users couldn't tell what they were approving
 * without clicking into it. Now shows a one-line summary by default with
 * an expand toggle. Uses native <details> for zero-dep accessibility.
 */
function ApprovalDetail({ detail }: { detail: string }) {
  // Extract a meaningful one-line summary. The detail is often pretty-printed
  // JSON truncated at 500 chars by the adapter, so JSON.parse may fail. Use
  // regex fallbacks so we still pull out the "interesting" bit.
  const summary = extractSummary(detail)

  const isLong = detail.length > summary.length + 20 || detail.includes('\n')

  if (!isLong) {
    return (
      <div style={{
        padding: '8px 12px',
        fontSize: '11.5px',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {detail}
      </div>
    )
  }

  return (
    <details style={{ padding: '6px 10px 8px' }}>
      <summary style={{
        cursor: 'pointer',
        fontSize: '11.5px',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        padding: '2px 2px',
        userSelect: 'none',
      }}>
        {summary}
      </summary>
      <pre style={{
        marginTop: '6px',
        padding: '6px 8px',
        fontSize: '11px',
        color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '260px',
        overflow: 'auto',
        background: 'rgba(0,0,0,0.1)',
        borderRadius: '4px',
        border: '1px solid var(--border)',
      }}>
        {detail}
      </pre>
    </details>
  )
}

/**
 * Extract a one-line summary from a tool-input detail string.
 *
 * The detail is often pretty-printed JSON truncated at 500 chars by the
 * adapter — so JSON.parse often fails on incomplete JSON. We try
 * structured extraction first, then regex fallback on common keys
 * (`file_path`, `command`, `path`, `url`) that appear in the raw text
 * even when the JSON is truncated.
 *
 * Previous bug: fallback was `detail.split('\n')[0]` which produced just
 * `{` for pretty-printed JSON — useless as a summary.
 */
function extractSummary(detail: string): string {
  // Try parsing as complete JSON first.
  try {
    const parsed = JSON.parse(detail)
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.command === 'string') return truncLine(parsed.command)
      if (typeof parsed.file_path === 'string') return truncLine(parsed.file_path)
      if (typeof parsed.path === 'string') return truncLine(parsed.path)
      if (typeof parsed.url === 'string') return truncLine(parsed.url)
      const firstKey = Object.keys(parsed)[0]
      if (firstKey) return truncLine(`${firstKey}: ${String(parsed[firstKey]).slice(0, 100)}`)
    }
  } catch {
    // JSON is likely truncated. Fall through to regex.
  }

  // Regex fallback — pull known keys from the raw (possibly truncated) text.
  // These patterns match pretty-printed JSON like: "file_path": "/Users/foo/bar.ts"
  for (const key of ['file_path', 'command', 'path', 'url']) {
    const match = new RegExp(`"${key}":\\s*"([^"]*)"`, 'i').exec(detail)
    if (match?.[1]) return truncLine(match[1])
  }

  // Last resort: first non-brace line (skip the opening `{`).
  const lines = detail.split('\n').map((l) => l.trim()).filter((l) => l && l !== '{' && l !== '}')
  if (lines[0]) return truncLine(lines[0])

  return truncLine(detail)
}

function truncLine(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}
