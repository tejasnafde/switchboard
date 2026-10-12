import { useState, useMemo, useRef } from 'react'
import type { ToolCall } from '@shared/types'
import { summarizeTool as summarizeToolShared } from '@shared/tool-summary'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'

const log = createRendererLogger('chat:tool-call')

interface ToolCallBlockProps {
  toolCall: ToolCall
  /** A subagent's step: the quieter type of the agent row. */
  step?: boolean
  /** The step running now, or the one its agent failed on. */
  emphasis?: 'current' | 'failed'
  /** Replaces "Running" at the end of the row, e.g. "Exit 1". */
  statusLabel?: string
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

function Icon({ kind }: { kind: ToolKind }) {
  const props = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (kind) {
    case 'bash':
      return (
        <svg {...props}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      )
    case 'read':
      return (
        <svg {...props}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
    case 'edit':
    case 'write':
      return (
        <svg {...props}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      )
    case 'glob':
      return (
        <svg {...props}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'grep':
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      )
    case 'agent':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      )
    case 'web':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    case 'todo':
      return (
        <svg {...props}>
          <polyline points="9 11 12 14 22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      )
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
  }
}

// ─── Summary / input rendering ────────────────────────────────────

interface ToolSummary {
  label: string
  detail?: string
  mono: boolean
}

/**
 * Desktop's `ToolCall.input` is a JSON string; the shared module takes an
 * already-parsed value, same as mobile. Malformed input degrades to the
 * same "raw name, no detail" fallback the previous desktop-only summarizer
 * used, rather than throwing.
 */
function summarizeTool(name: string, input: string): ToolSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    parsed = undefined
  }
  const { title, detail, mono } = summarizeToolShared(name, parsed)
  return { label: title, detail: detail || undefined, mono }
}

// ─── Expanded body per tool type ──────────────────────────────────

const bodyClass = 'flex flex-col gap-[6px] px-[12px] py-[8px]'
const monoClass = '[font-family:var(--font-mono)]'

function ExpandedBody({ kind, toolCall }: { kind: ToolKind; toolCall: ToolCall }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(toolCall.input)
    } catch {
      return null
    }
  }, [toolCall.input])

  if (kind === 'bash' && parsed) {
    return (
      <div className={bodyClass}>
        <CodeBlock variant="command">$ {parsed.command}</CodeBlock>
        {parsed.description && <div className="text-[11px] text-[var(--text-muted)]">{parsed.description}</div>}
        {toolCall.output && <CodeBlock variant="output">{toolCall.output}</CodeBlock>}
      </div>
    )
  }

  if ((kind === 'edit' || kind === 'write') && parsed) {
    return (
      <div className={bodyClass}>
        <FileLabel path={parsed.file_path} />
        {parsed.move_path && (
          <div className={cn('text-[11px] text-[var(--text-secondary)]', monoClass)}>→ {parsed.move_path}</div>
        )}
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
      <div className={bodyClass}>
        <FileLabel path={parsed.file_path} />
        {(parsed.offset || parsed.limit) && (
          <div className={cn('text-[11px] text-[var(--text-muted)]', monoClass)}>
            {parsed.offset && `offset=${parsed.offset}`}
            {parsed.offset && parsed.limit && ' · '}
            {parsed.limit && `limit=${parsed.limit}`}
          </div>
        )}
        {toolCall.output && <CodeBlock variant="code">{toolCall.output}</CodeBlock>}
      </div>
    )
  }

  if (kind === 'todo' && parsed?.todos) {
    return (
      <div className="px-[12px] py-[8px]">
        {(parsed.todos as Array<{ status?: string; content?: string; text?: string }>).map((t, i) => (
          <div key={i} className="flex items-start gap-[6px] py-[3px] text-[12px]">
            <span
              className={cn(
                'mt-[2px] text-[10px]',
                t.status === 'completed'
                  ? 'text-[var(--success)]'
                  : t.status === 'in_progress'
                    ? 'text-[var(--warning)]'
                    : 'text-[var(--text-muted)]',
              )}
            >
              {t.status === 'completed' ? '●' : t.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span
              className={cn(
                'flex-1',
                t.status === 'completed'
                  ? 'text-[var(--text-muted)] line-through'
                  : 'text-[var(--text-secondary)] no-underline',
              )}
            >
              {t.content || t.text}
            </span>
          </div>
        ))}
      </div>
    )
  }

  // Fallback: raw JSON input + output
  return (
    <div className={bodyClass}>
      <CodeBlock variant="code">{toolCall.input}</CodeBlock>
      {toolCall.output && <CodeBlock variant="output">{toolCall.output}</CodeBlock>}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────

function FileLabel({ path }: { path: string }) {
  return (
    <div
      className={cn(
        'inline-block self-start rounded-[3px] bg-[var(--accent-subtle)] px-[6px] py-[3px] text-[11px] text-[var(--accent)]',
        monoClass,
      )}
    >
      {path}
    </div>
  )
}

const preClass = cn(
  'm-0 overflow-auto whitespace-pre-wrap rounded-[3px] px-[10px] py-[6px] text-[11px] [word-break:break-word]',
  monoClass,
)

const codeVariantClass = {
  command: 'border-l-2 border-l-[#10b981] bg-[rgba(16,185,129,0.06)] text-[var(--text-primary)]',
  output: 'border-l-2 border-l-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]',
  code: 'border-l-2 border-l-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)]',
} as const

function CodeBlock({ variant, children }: { variant: 'command' | 'output' | 'code'; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLSpanElement>(null)

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    const text = codeRef.current?.textContent ?? ''
    if (typeof navigator.clipboard?.writeText !== 'function') return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((error: unknown) => {
        log.warn('clipboard write failed', error)
      })
  }

  return (
    <div className="tool-code-block">
      <div className="tool-code-toolbar">
        <button
          onClick={handleCopy}
          className={`code-copy-btn${copied ? ' copied' : ''}`}
          type="button"
          aria-label={`${copied ? 'Copied' : 'Copy'} code block`}
          aria-live="polite"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={cn(preClass, 'max-h-[240px]', codeVariantClass[variant])}>
        <span ref={codeRef}>{children}</span>
      </pre>
    </div>
  )
}

function DiffChunk({ type, content }: { type: 'add' | 'remove'; content: string }) {
  const isAdd = type === 'add'
  return (
    <pre
      className={cn(
        preClass,
        'max-h-[200px] border-l-2 text-[var(--text-primary)]',
        isAdd
          ? 'border-l-[var(--success)] bg-[rgba(63,185,80,0.08)]'
          : 'border-l-[var(--error)] bg-[rgba(248,81,73,0.08)]',
      )}
    >
      {content.split('\n').map((line, i) => (
        <div key={i}>
          <span className={cn('mr-[6px] select-none', isAdd ? 'text-[var(--success)]' : 'text-[var(--error)]')}>
            {isAdd ? '+' : '-'}
          </span>
          {line}
        </div>
      ))}
    </pre>
  )
}

// ─── Main component ───────────────────────────────────────────────

export function ToolCallBlock({ toolCall, step, emphasis, statusLabel }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const kind = classifyTool(toolCall.name)
  const summary = useMemo(() => summarizeTool(toolCall.name, toolCall.input), [toolCall.name, toolCall.input])
  const status = statusLabel ?? (toolCall.output ? undefined : 'Running')

  return (
    <div className={cn('tool-call-row', step && '!mt-0')}>
      <button
        className={cn('tool-call-trigger', step && '!py-[3px] !text-[11.5px]')}
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Neutral glyph: tool type is useful; decorative category color is not. */}
        <span
          className={cn(
            'inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center',
            emphasis === 'current'
              ? 'text-[var(--accent)]'
              : emphasis === 'failed'
                ? 'text-[var(--error)]'
                : 'text-[var(--text-muted)]',
          )}
        >
          <Icon kind={kind} />
        </span>

        {/* Label */}
        <span
          className={cn(
            'shrink-0',
            step
              ? cn(
                  'text-[11.5px] font-[400]',
                  emphasis === 'current' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                )
              : 'text-[12px] font-[500] text-[var(--text-primary)]',
          )}
        >
          {summary.label}
        </span>

        {/* Detail - monospace, truncated */}
        {summary.detail && (
          <span
            className={cn(
              'flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--text-muted)]',
              summary.mono ? monoClass : '[font-family:inherit]',
            )}
            title={summary.detail}
          >
            {summary.detail}
          </span>
        )}

        {!summary.detail && <span className="flex-1" />}

        {status && (
          <span
            className={cn(
              'shrink-0',
              step ? 'text-[11px]' : 'text-[10px]',
              emphasis === 'failed' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]',
            )}
          >
            {status}
          </span>
        )}

        {/* Chevron */}
        <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-surface)]">
          <ExpandedBody kind={kind} toolCall={toolCall} />
        </div>
      )}
    </div>
  )
}
