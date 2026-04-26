import { useState, useMemo } from 'react'
import type { ToolCall } from '@shared/types'

interface ToolCallBlockProps {
  toolCall: ToolCall
}

// ─── Per-tool metadata ────────────────────────────────────────────

type ToolKind = 'bash' | 'read' | 'edit' | 'write' | 'glob' | 'grep' | 'agent' | 'web' | 'todo' | 'other'

function classifyTool(name: string): ToolKind {
  const n = name.toLowerCase()
  if (n === 'bash' || n.includes('shell')) return 'bash'
  if (n === 'read') return 'read'
  if (n === 'edit' || n.includes('multiedit')) return 'edit'
  if (n === 'write') return 'write'
  if (n === 'glob') return 'glob'
  if (n === 'grep') return 'grep'
  if (n === 'agent' || n === 'task') return 'agent'
  if (n.includes('webfetch') || n.includes('websearch')) return 'web'
  if (n.includes('todo')) return 'todo'
  return 'other'
}

const KIND_COLORS: Record<ToolKind, { fg: string; bg: string }> = {
  bash:  { fg: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
  read:  { fg: '#3b82f6', bg: 'rgba(59, 130, 246, 0.1)' },
  edit:  { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
  write: { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)' },
  glob:  { fg: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)' },
  grep:  { fg: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)' },
  agent: { fg: '#ec4899', bg: 'rgba(236, 72, 153, 0.1)' },
  web:   { fg: '#06b6d4', bg: 'rgba(6, 182, 212, 0.1)' },
  todo:  { fg: '#a78bfa', bg: 'rgba(167, 139, 250, 0.1)' },
  other: { fg: 'var(--text-muted)', bg: 'var(--bg-tertiary)' },
}

function Icon({ kind }: { kind: ToolKind }) {
  const props = { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (kind) {
    case 'bash':  return <svg {...props}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
    case 'read':  return <svg {...props}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
    case 'edit':
    case 'write': return <svg {...props}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
    case 'glob':  return <svg {...props}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
    case 'grep':  return <svg {...props}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
    case 'agent': return <svg {...props}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
    case 'web':   return <svg {...props}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
    case 'todo':  return <svg {...props}><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
    default:      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  }
}

// ─── Summary / input rendering ────────────────────────────────────

interface ToolSummary {
  label: string
  detail?: string
}

function summarizeTool(kind: ToolKind, name: string, input: string): ToolSummary {
  try {
    const p = JSON.parse(input)
    switch (kind) {
      case 'bash':
        return { label: 'Bash', detail: p.command || '' }
      case 'read':
        return { label: 'Read', detail: shortenPath(p.file_path) }
      case 'edit':
        return { label: 'Edit', detail: shortenPath(p.file_path) }
      case 'write':
        return { label: 'Write', detail: shortenPath(p.file_path) }
      case 'glob':
        return { label: 'Glob', detail: p.pattern || '' }
      case 'grep':
        return { label: 'Grep', detail: p.pattern ? `"${p.pattern}"${p.path ? ` in ${shortenPath(p.path)}` : ''}` : '' }
      case 'agent':
        return { label: 'Subagent', detail: p.description || p.prompt?.slice(0, 80) || '' }
      case 'web':
        return { label: 'Web', detail: p.url || p.query || '' }
      case 'todo':
        return { label: 'Todos', detail: Array.isArray(p.todos) ? `${p.todos.length} items` : '' }
      default:
        return { label: name }
    }
  } catch {
    return { label: name }
  }
}

function shortenPath(path?: string): string {
  if (!path) return ''
  // Collapse home dir
  const home = '/Users/'
  if (path.startsWith(home)) {
    const parts = path.split('/')
    // /Users/tejas/Desktop/projects/switchboard/src/file.ts → …/switchboard/src/file.ts
    if (parts.length > 5) {
      return '…/' + parts.slice(-3).join('/')
    }
  }
  return path
}

// ─── Expanded body per tool type ──────────────────────────────────

function ExpandedBody({ kind, toolCall }: { kind: ToolKind; toolCall: ToolCall }) {
  const parsed = useMemo(() => {
    try { return JSON.parse(toolCall.input) } catch { return null }
  }, [toolCall.input])

  if (kind === 'bash' && parsed) {
    return (
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <CodeBlock variant="command">$ {parsed.command}</CodeBlock>
        {parsed.description && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{parsed.description}</div>
        )}
        {toolCall.output && <CodeBlock variant="output">{toolCall.output}</CodeBlock>}
      </div>
    )
  }

  if ((kind === 'edit' || kind === 'write') && parsed) {
    return (
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <FileLabel path={parsed.file_path} />
        {kind === 'edit' ? (
          <>
            {parsed.old_string && <DiffChunk type="remove" content={parsed.old_string} />}
            {parsed.new_string && <DiffChunk type="add" content={parsed.new_string} />}
          </>
        ) : (
          parsed.content && <CodeBlock variant="code">{parsed.content}</CodeBlock>
        )}
        {toolCall.output && <CodeBlock variant="output">{toolCall.output}</CodeBlock>}
      </div>
    )
  }

  if (kind === 'read' && parsed) {
    return (
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <FileLabel path={parsed.file_path} />
        {(parsed.offset || parsed.limit) && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {parsed.offset && `offset=${parsed.offset}`}{parsed.offset && parsed.limit && ' · '}{parsed.limit && `limit=${parsed.limit}`}
          </div>
        )}
        {toolCall.output && <CodeBlock variant="code">{toolCall.output}</CodeBlock>}
      </div>
    )
  }

  if (kind === 'todo' && parsed?.todos) {
    return (
      <div style={{ padding: '8px 12px' }}>
        {parsed.todos.map((t: any, i: number) => (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
            padding: '3px 0',
            fontSize: '12px',
          }}>
            <span style={{
              fontSize: '10px',
              color: t.status === 'completed' ? 'var(--success)' : t.status === 'in_progress' ? 'var(--warning)' : 'var(--text-muted)',
              marginTop: '2px',
            }}>
              {t.status === 'completed' ? '●' : t.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span style={{
              color: t.status === 'completed' ? 'var(--text-muted)' : 'var(--text-secondary)',
              textDecoration: t.status === 'completed' ? 'line-through' : 'none',
              flex: 1,
            }}>
              {t.content || t.text}
            </span>
          </div>
        ))}
      </div>
    )
  }

  // Fallback: raw JSON input + output
  return (
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <CodeBlock variant="code">{toolCall.input}</CodeBlock>
      {toolCall.output && <CodeBlock variant="output">{toolCall.output}</CodeBlock>}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────

function FileLabel({ path }: { path: string }) {
  return (
    <div style={{
      fontSize: '11px',
      fontFamily: 'var(--font-mono)',
      color: 'var(--accent)',
      padding: '3px 6px',
      background: 'var(--accent-subtle)',
      borderRadius: '3px',
      display: 'inline-block',
      alignSelf: 'flex-start',
    }}>
      {path}
    </div>
  )
}

function CodeBlock({ variant, children }: { variant: 'command' | 'output' | 'code'; children: React.ReactNode }) {
  const variantStyles: Record<string, React.CSSProperties> = {
    command: {
      background: 'rgba(16, 185, 129, 0.06)',
      color: 'var(--text-primary)',
      borderLeft: '2px solid #10b981',
    },
    output: {
      background: 'var(--bg-primary)',
      color: 'var(--text-secondary)',
      borderLeft: '2px solid var(--border)',
    },
    code: {
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      borderLeft: '2px solid var(--border)',
    },
  }
  return (
    <pre style={{
      margin: 0,
      padding: '6px 10px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflow: 'auto',
      maxHeight: '240px',
      borderRadius: '3px',
      ...variantStyles[variant],
    }}>
      {children}
    </pre>
  )
}

function DiffChunk({ type, content }: { type: 'add' | 'remove'; content: string }) {
  const isAdd = type === 'add'
  return (
    <pre style={{
      margin: 0,
      padding: '6px 10px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflow: 'auto',
      maxHeight: '200px',
      borderRadius: '3px',
      background: isAdd ? 'rgba(63, 185, 80, 0.08)' : 'rgba(248, 81, 73, 0.08)',
      color: 'var(--text-primary)',
      borderLeft: `2px solid ${isAdd ? 'var(--success)' : 'var(--error)'}`,
    }}>
      {content.split('\n').map((line, i) => (
        <div key={i}>
          <span style={{
            color: isAdd ? 'var(--success)' : 'var(--error)',
            marginRight: '6px',
            userSelect: 'none',
          }}>
            {isAdd ? '+' : '-'}
          </span>
          {line}
        </div>
      ))}
    </pre>
  )
}

// ─── Main component ───────────────────────────────────────────────

export function ToolCallBlock({ toolCall }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const kind = classifyTool(toolCall.name)
  const colors = KIND_COLORS[kind]
  const summary = useMemo(() => summarizeTool(kind, toolCall.name, toolCall.input), [kind, toolCall.name, toolCall.input])
  const hasRunning = !toolCall.output

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        marginTop: '6px',
        overflow: 'hidden',
        fontSize: '12px',
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '12px',
        }}
      >
        {/* Colored icon pill */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '22px',
          height: '22px',
          borderRadius: '4px',
          background: colors.bg,
          color: colors.fg,
          flexShrink: 0,
        }}>
          <Icon kind={kind} />
        </span>

        {/* Label */}
        <span style={{
          color: 'var(--text-primary)',
          fontWeight: 500,
          fontSize: '12px',
          flexShrink: 0,
        }}>
          {summary.label}
        </span>

        {/* Detail — monospace, truncated */}
        {summary.detail && (
          <span style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--text-muted)',
          }} title={summary.detail}>
            {summary.detail}
          </span>
        )}

        {!summary.detail && <span style={{ flex: 1 }} />}

        {/* Status dot */}
        <span style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: hasRunning ? 'var(--warning)' : 'var(--success)',
          flexShrink: 0,
          opacity: 0.7,
        }} />

        {/* Chevron */}
        <span style={{
          fontSize: '9px',
          color: 'var(--text-muted)',
          flexShrink: 0,
        }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-surface)',
        }}>
          <ExpandedBody kind={kind} toolCall={toolCall} />
        </div>
      )}
    </div>
  )
}
