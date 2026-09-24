import { useEffect, useMemo, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agent-store'
import {
  findActiveTerminalSelection,
  captureTerminalContext,
  formatTerminalContext,
  sendQuickPrompt,
} from '../services/contextBridge'
import { useLayoutStore } from '../stores/layout-store'
import { cn } from '../lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

interface QuickPromptModalProps {
  open: boolean
  onClose: () => void
  /** Pre-filled context from a workbench cmd+k selection (wins over terminal selection). */
  ideContext?: { preview: string; full: string } | null
  targetSessionId?: string | null
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
export function QuickPromptModal({ open, onClose, ideContext, targetSessionId }: QuickPromptModalProps) {
  const focusedSessionId = useLayoutStore((s) =>
    s.focusedChatSlot === 'secondary' && s.secondarySessionId
      ? s.secondarySessionId
      : s.primarySessionId,
  )
  const resolvedSessionId = targetSessionId ?? focusedSessionId
  const activeSession = useAgentStore((s) =>
    s.sessions.find((sess) => sess.id === resolvedSessionId),
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

    if (ideContext) {
      setContext(ideContext)
    } else {
      const found = findActiveTerminalSelection(resolvedSessionId)
      if (found) {
        const ctx = captureTerminalContext(found.sessionId, found.paneId, found.selection)
        const block = formatTerminalContext(ctx)
        const preview = found.selection.split('\n')[0].slice(0, 80)
        setContext({ preview: `${ctx.paneLabel}: ${preview}`, full: block })
      } else {
        setContext(null)
      }
    }

  }, [open, ideContext, resolvedSessionId])

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
    const ok = await sendQuickPrompt(message, { includeTerminalSelection: false, sessionId: activeSession.id })
    if (ok) {
      onClose()
    } else {
      setStatus('error')
      setErrorMsg('Could not send. Is there an active chat?')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          textareaRef.current?.focus()
        }}
        overlayClassName="z-[1300] bg-[rgba(0,0,0,0.4)]"
        className="sb-floating-surface inset-x-0 top-[15vh] z-[1300] mx-auto flex w-[min(620px,92vw)] flex-col gap-[10px] rounded-[var(--radius-lg,10px)] border border-[var(--border)] px-[16px] py-[14px] shadow-[0_20px_60px_rgba(0,0,0,0.5)]!"
      >
        {/* Target session banner */}
        <div className="flex items-center gap-[8px] text-[10.5px] text-[var(--text-muted)]">
          <DialogTitle className="text-[10.5px] font-[600] uppercase tracking-[0.7px]">
            Quick prompt
          </DialogTitle>
          {activeSession ? (
            <span>
              → <span className="text-[var(--text-secondary)]">{agentLabel}</span>
              {' · '}
              <span className="[font-family:var(--font-mono)]">
                {activeSession.title ?? activeSession.id.slice(0, 8)}
              </span>
            </span>
          ) : (
            <span className="text-[var(--error)]">
              No active chat - open or create one first.
            </span>
          )}
        </div>

        {/* Context pill (if terminal selection was captured) */}
        {context && (
          <div className="flex items-center gap-[8px] rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[10px] py-[5px] text-[11.5px]">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="flex-1 truncate text-[10.5px] [font-family:var(--font-mono)] text-[var(--text-secondary)]">
              With context · {context.preview}
            </span>
            <button
              onClick={() => setContext(null)}
              title="Remove context"
              className="cursor-pointer border-0 bg-transparent px-[4px] text-[14px] leading-none text-[var(--text-muted)]"
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
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) void handleSend()
            }
          }}
          placeholder={`Ask ${agentLabel}…`}
          rows={2}
          className="max-h-[200px] w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)] px-[12px] py-[10px] text-[14px] leading-[1.5] [font-family:var(--font-sans)] text-[var(--text-primary)] outline-none"
        />

        {/* Footer */}
        <div className="flex items-center justify-between text-[10.5px] text-[var(--text-muted)]">
          <span>
            Enter to send · Shift+Enter newline · Esc to dismiss
          </span>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              'rounded-[4px] border-0 px-[14px] py-[5px] text-[11.5px] font-[600]',
              canSend ? 'cursor-pointer bg-[var(--accent)] text-[#fff]' : 'cursor-default bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
            )}
          >
            {status === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>

        {status === 'error' && errorMsg && (
          <div className="text-[11px] text-[var(--error)]">{errorMsg}</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
