import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agent-store'
import {
  findActiveTerminalSelection,
  captureTerminalContext,
  formatTerminalContext,
  sendQuickPrompt,
} from '../services/contextBridge'

interface QuickPromptModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Spotlight-style quick prompt (⌘+K).
 *
 * Floating centered prompt bar that sends a one-shot message to the
 * currently-active chat session. If there's a terminal selection when
 * opened, it's attached as context and shown as a pill above the input
 * (click × to remove).
 *
 * Escapes via Esc or outside-click. Enter sends; Shift+Enter newline.
 */
export function QuickPromptModal({ open, onClose }: QuickPromptModalProps) {
  const activeSession = useAgentStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId),
  )
  const [value, setValue] = useState('')
  const [context, setContext] = useState<{ preview: string; full: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // On open: reset state, pre-fill context from any terminal selection,
  // and focus the input.
  useEffect(() => {
    if (!open) return
    setValue('')
    setStatus('idle')
    setErrorMsg(null)

    const found = findActiveTerminalSelection()
    if (found) {
      const ctx = captureTerminalContext(found.sessionId, found.paneId, found.selection)
      const block = formatTerminalContext(ctx)
      const preview = found.selection.split('\n')[0].slice(0, 80)
      setContext({ preview: `${ctx.paneLabel}: ${preview}`, full: block })
    } else {
      setContext(null)
    }

    // Focus after mount so the cursor starts in the input.
    setTimeout(() => textareaRef.current?.focus(), 20)
  }, [open])

  const agentLabel = useMemo(() => {
    if (!activeSession) return 'agent'
    return activeSession.type === 'codex' ? 'Codex' : activeSession.type === 'opencode' ? 'OpenCode' : 'Claude'
  }, [activeSession])

  const canSend = value.trim().length > 0 && !!activeSession && status !== 'sending'

  const handleSend = async () => {
    const prompt = value.trim()
    if (!prompt || !activeSession) return

    setStatus('sending')
    // Build the final message: context block (if present) + prompt
    const message = context ? `${context.full}\n${prompt}` : prompt
    const ok = await sendQuickPrompt(message, { includeTerminalSelection: false })
    if (ok) {
      onClose()
    } else {
      setStatus('error')
      setErrorMsg('Could not send. Is there an active chat?')
    }
  }

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '15vh',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(620px, 92vw)',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg, 10px)',
          padding: '14px 16px',
          gap: '10px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Target session banner */}
        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600 }}>
            Quick prompt
          </span>
          {activeSession ? (
            <span>
              → <span style={{ color: 'var(--text-secondary)' }}>{agentLabel}</span>
              {' · '}
              <span style={{ fontFamily: 'var(--font-mono)' }}>
                {activeSession.title ?? activeSession.id.slice(0, 8)}
              </span>
            </span>
          ) : (
            <span style={{ color: 'var(--error)' }}>
              No active chat — open or create one first.
            </span>
          )}
        </div>

        {/* Context pill (if terminal selection was captured) */}
        {context && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '5px 10px',
            borderRadius: '4px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)',
            fontSize: '11.5px',
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span style={{
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              With context · {context.preview}
            </span>
            <button
              onClick={() => setContext(null)}
              title="Remove context"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '0 4px',
                fontSize: '14px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        )}

        {/* Input */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose() }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) void handleSend()
            }
          }}
          placeholder={`Ask ${agentLabel}…`}
          rows={2}
          style={{
            width: '100%',
            resize: 'none',
            padding: '10px 12px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.5,
            outline: 'none',
            maxHeight: '200px',
          }}
        />

        {/* Footer */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          <span>
            Enter to send · Shift+Enter newline · Esc to dismiss
          </span>
          <button
            onClick={handleSend}
            disabled={!canSend}
            style={{
              padding: '5px 14px',
              borderRadius: '4px',
              border: 'none',
              background: canSend ? 'var(--accent)' : 'var(--bg-tertiary)',
              color: canSend ? '#fff' : 'var(--text-muted)',
              cursor: canSend ? 'pointer' : 'default',
              fontSize: '11.5px',
              fontWeight: 600,
            }}
          >
            {status === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>

        {status === 'error' && errorMsg && (
          <div style={{ fontSize: '11px', color: 'var(--error)' }}>{errorMsg}</div>
        )}
      </div>
    </div>
  )
}
