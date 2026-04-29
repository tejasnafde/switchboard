import { memo, useMemo, useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import { agentShortLabel, type ChatMessage } from '@shared/types'
import { fmtDuration } from '@shared/format'
import { ToolCallBlock } from './ToolCallBlock'
import { ApprovalCard } from './ApprovalCard'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { useAgentStore } from '../../stores/agent-store'
import { useDraftStore } from '../../stores/draft-store'
import { useLayoutStore } from '../../stores/layout-store'
import { enhanceFilePills } from '../../services/messagePills'
import { formatFilePathRef, type FilePathRef } from '@shared/filePathRef'

interface MessageBubbleProps {
  message: ChatMessage
  onApproval?: (requestId: string, decision: 'approve' | 'deny', note?: string) => void
  onAnswerQuestion?: (requestId: string, answers: string[][]) => void
  onPlanAction?: (planId: string, action: 'implement' | 'iterate') => void
}

export const MessageBubble = memo(function MessageBubble({ message, onApproval, onAnswerQuestion, onPlanAction }: MessageBubbleProps) {
  const renderedContent = useMemo(() => {
    if (!message.content) return ''
    // Escape lone tildes used as "approximately" (e.g. ~34) so they don't
    // pair up into ~~strikethrough~~ in GFM markdown.
    const escaped = message.content.replace(/~(\d)/g, '\\~$1')
    return marked.parse(escaped, { async: false }) as string
  }, [message.content])

  const [copied, setCopied] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const markdownRef = useRef<HTMLDivElement>(null)

  // Inject copy buttons on each <pre> code block after markdown renders
  useEffect(() => {
    const root = markdownRef.current
    if (!root) return
    const pres = root.querySelectorAll('pre')
    pres.forEach((pre) => {
      // Skip if already processed
      if (pre.querySelector(':scope > .code-copy-btn')) return
      pre.style.position = 'relative'
      const btn = document.createElement('button')
      btn.className = 'code-copy-btn'
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const code = pre.querySelector('code')
        const text = code?.textContent ?? pre.textContent ?? ''
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied'
          btn.classList.add('copied')
          setTimeout(() => {
            btn.textContent = 'Copy'
            btn.classList.remove('copied')
          }, 1500)
        }).catch(() => {})
      })
      pre.appendChild(btn)
    })
  }, [renderedContent])

  // Inline file-pill enhancement: replace `<code>src/foo.ts:42-58</code>`
  // with clickable chips that open the file viewer at that line range.
  // Verifies existence on disk via debounced files:resolve before swapping
  // — paths the agent hallucinated stay as plain code.
  useEffect(() => {
    const root = markdownRef.current
    if (!root) return
    const store = useAgentStore.getState()
    const session = store.sessions.find((s) => s.id === store.activeSessionId)
    const projectPath = session?.projectPath
    if (!projectPath) return

    enhanceFilePills(root, (ref: FilePathRef, originalText: string) => {
      const span = document.createElement('span')
      span.className = 'file-chip'
      span.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:4px',
        'padding:1px 6px',
        'margin:0 1px',
        'border:1px solid var(--border)',
        'border-radius:4px',
        'background:var(--bg-tertiary)',
        'font-family:var(--font-mono)',
        'font-size:12px',
        'cursor:pointer',
        'vertical-align:baseline',
      ].join(';')
      span.textContent = originalText
      span.title = `Open ${formatFilePathRef(ref)}`
      span.setAttribute('data-context-source', 'file-chip')
      span.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        useLayoutStore.getState().openInViewer(
          ref.path,
          ref.startLine && ref.endLine
            ? { start: ref.startLine, end: ref.endLine }
            : null,
        )
      })

      // Async existence check — if the file doesn't resolve, revert to plain code.
      const api = (window as any).api
      if (api?.files?.resolve) {
        api.files.resolve(projectPath, ref.path).then((res: { exists: boolean }) => {
          if (!res?.exists) {
            const code = document.createElement('code')
            code.textContent = originalText
            span.replaceWith(code)
          }
        }).catch(() => { /* ignore — leave optimistic chip */ })
      }
      return span
    })
  }, [renderedContent])

  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const isError = isSystem && /^Error:/i.test(message.content)

  // Skip rendering if completely empty
  if (!message.content
    && !message.toolCalls?.length
    && !message.approval
    && !message.images?.length
    && !message.plan
    && !message.question) {
    return null
  }

  const handleCopy = () => {
    const text = message.content || ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div
      className="message-bubble-row"
      data-message-id={message.id}
      data-context-source={message.role === 'assistant' ? 'chat-message' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        padding: '3px 16px',
      }}
    >
      {/* Message content */}
      <div
        className="message-bubble"
        style={{
          maxWidth: isUser ? '80%' : '100%',
          padding: message.content ? '10px 14px' : '0',
          borderRadius: 'var(--radius)',
          background: isUser
            ? 'var(--bg-tertiary)'
            : isError
              ? 'rgba(248, 81, 73, 0.08)'
              : isSystem
                ? 'rgba(210, 153, 34, 0.08)'
                : message.content ? 'var(--bg-secondary)' : 'transparent',
          border: isError
            ? '1px solid rgba(248, 81, 73, 0.35)'
            : isSystem
              ? '1px solid rgba(210, 153, 34, 0.35)'
              : 'none',
          fontSize: '13px',
          lineHeight: 1.6,
          position: 'relative',
        }}
      >
        {/* Render markdown for assistant, plain text for user */}
        {message.content && (isUser ? (
          <div style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}>{message.content}</div>
        ) : (
          <div
            ref={markdownRef}
            className="markdown-content"
            dangerouslySetInnerHTML={{ __html: renderedContent }}
            style={{ overflow: 'hidden' }}
          />
        ))}

        {/* Attached images */}
        {message.images && message.images.length > 0 && (
          <div style={{
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            marginTop: message.content ? '8px' : '0',
          }}>
            {message.images.map((img, i) => (
              <div
                key={i}
                onClick={() => setPreviewImage(img.url)}
                style={{
                  width: '120px',
                  height: '90px',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  transition: 'opacity 0.12s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.85' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              >
                <img
                  src={img.url}
                  alt={img.name || 'attachment'}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls?.map((tc) => (
          <ToolCallBlock key={tc.id} toolCall={tc} />
        ))}

        {/* Approval request */}
        {message.approval && onApproval && (
          <ApprovalCard message={message} onDecide={onApproval} />
        )}

        {/* Plan proposal from agent exiting plan mode */}
        {message.plan && (
          <PlanCard
            plan={message.plan}
            onApprove={() => onPlanAction?.(message.plan!.id, 'implement')}
            onReject={() => onPlanAction?.(message.plan!.id, 'iterate')}
          />
        )}

        {/* AskUserQuestion request */}
        {message.question && (
          <QuestionCard
            question={message.question}
            onAnswer={(answers) => onAnswerQuestion?.(message.question!.requestId, answers)}
          />
        )}

        {/* Policy-level tool denial (e.g. Plan mode blocked Write) */}
        {message.denial && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '6px 10px',
              margin: '4px 0',
              borderRadius: 'var(--radius)',
              border: '1px solid rgba(248, 81, 73, 0.35)',
              borderLeft: '3px solid var(--danger, #f85149)',
              background: 'rgba(248, 81, 73, 0.08)',
              fontSize: '11.5px',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger, #f85149)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Blocked
            </span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ fontWeight: 500 }}>{message.denial.toolName}</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}>
              {message.denial.mode === 'plan'
                ? 'Plan mode — switch to Sandbox/Edits to execute'
                : message.denial.reason}
            </span>
          </div>
        )}

        {/* Per-turn duration ("Worked for 1.4s") — Cursor-style indicator
            shown only on the last assistant message of a completed turn. */}
        {message.role === 'assistant' && typeof message.turnDurationMs === 'number' && (
          <div
            style={{
              fontSize: '10.5px',
              color: 'var(--text-muted)',
              marginTop: '4px',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.2px',
              userSelect: 'none',
            }}
            title={`Turn took ${message.turnDurationMs}ms`}
          >
            Worked for {fmtDuration(message.turnDurationMs)}
          </div>
        )}

        {/* TCC Error with Relaunch Button */}
        {isError && message.content.includes('macOS is blocking Switchboard from reading') && (
          <div style={{ marginTop: '8px' }}>
            <button
              onClick={() => window.api.app.relaunch()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                borderRadius: '4px',
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 500,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Relaunch to Apply Permissions
            </button>
          </div>
        )}
      </div>

      {/* Message action bar — sits BELOW the bubble so the buttons never
          overlap message text. Low opacity at rest; full on bubble-row
          hover (via `.message-bubble-row:hover` CSS rule). Leaves room
          here for future actions (edit, retry, thread, etc). */}
      {message.content && (
        <div
          className="message-actions"
          style={{
            display: 'flex',
            gap: '4px',
            marginTop: '2px',
            paddingRight: isUser ? '2px' : 0,
            paddingLeft: isUser ? 0 : '2px',
            opacity: 0,
            transition: 'opacity 0.12s',
          }}
        >
          <ForwardMenu content={message.content} />
          <button
            onClick={handleCopy}
            title="Copy message"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '3px 6px',
              borderRadius: '3px',
              border: '1px solid var(--border)',
              background: 'var(--bg-tertiary)',
              color: copied ? 'var(--success)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {/* Image lightbox — portalled to document.body so it escapes any
          transformed or overflow-hidden ancestor (the virtualizer uses
          transform on each row, which otherwise clips this to the row). */}
      {previewImage && createPortal(
        <div
          onClick={() => setPreviewImage(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            const imgEl = document.createElement('img')
            imgEl.crossOrigin = 'anonymous'
            imgEl.src = previewImage
            imgEl.onload = () => {
              const canvas = document.createElement('canvas')
              canvas.width = imgEl.naturalWidth
              canvas.height = imgEl.naturalHeight
              canvas.getContext('2d')?.drawImage(imgEl, 0, 0)
              canvas.toBlob((blob) => {
                if (blob) {
                  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {})
                }
              }, 'image/png')
            }
            setPreviewImage(null)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '80vh' }}>
            <img
              src={previewImage}
              alt="preview"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '90vw',
                maxHeight: '80vh',
                objectFit: 'contain',
                borderRadius: '8px',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
              }}
            />
            <div style={{
              position: 'absolute',
              bottom: '-28px',
              left: '50%',
              transform: 'translateX(-50%)',
              color: 'rgba(255,255,255,0.5)',
              fontSize: '11px',
              whiteSpace: 'nowrap',
            }}>
              Click to close · Right-click to copy
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
})

/**
 * Forward-to-another-agent menu.
 *
 * Lists other open sessions in a small popover. Clicking one appends the
 * message content to that session's draft (prefixed with a blockquote so
 * the receiving agent sees the forwarded context clearly) and opens the
 * session in the right-hand panel via layout-store's `openRightPanel`.
 */
function ForwardMenu({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Popover position in viewport coords — recomputed on open + scroll/resize
  // so it stays anchored to the button after portalling to document.body.
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const sessions = useAgentStore((s) => s.sessions)
  const appendDraft = useDraftStore((s) => s.appendDraft)
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setActiveSession = useAgentStore((s) => s.setActiveSession)

  // Close on click-outside + Escape. Replaces the brittle onMouseLeave
  // close which triggered the moment the cursor crossed the 2px gap
  // between the Forward button and its popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      const insideRoot = target && rootRef.current && rootRef.current.contains(target)
      const insidePopover = target && popoverRef.current && popoverRef.current.contains(target)
      if (!insideRoot && !insidePopover) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Compute popover anchor position whenever we open. The popover is
  // portalled to document.body (to escape the virtualizer's transform
  // clipping), so we position via viewport-relative `top` / `right`.
  useEffect(() => {
    if (!open) { setPopoverPos(null); return }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPopoverPos({
      top: rect.bottom + 2,
      right: window.innerWidth - rect.right,
    })
    // Update on scroll/resize so the popover tracks the button.
    const reposition = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (!r) return
      setPopoverPos({ top: r.bottom + 2, right: window.innerWidth - r.right })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  const others = sessions.filter((s) => s.id !== activeSessionId)

  // Used to be `if (others.length === 0) return null` — that hid the
  // button entirely for single-session users and made the feature
  // undiscoverable. Now always show the button; when clicked with no
  // targets, the popover shows an empty-state.

  const handleForward = (targetId: string, targetTitle: string | undefined) => {
    const sourceTitle = sessions.find((s) => s.id === activeSessionId)?.title ?? 'chat'
    const quoted = content
      .split('\n')
      .slice(0, 40) // cap forwarded context
      .map((line) => `> ${line}`)
      .join('\n')
    appendDraft(
      targetId,
      `[Forwarded from "${sourceTitle}"]\n${quoted}\n\n`,
    )
    // Open the target session in the right panel if dual-chat is not already
    // showing it; otherwise just focus it.
    openRightPanel(targetId)
    setActiveSession(targetId)
    setOpen(false)
    void targetTitle // reserved for future toast
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title="Forward to another agent"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 6px',
          borderRadius: '3px',
          border: '1px solid var(--border)',
          background: 'var(--bg-tertiary)',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          lineHeight: 1,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 17 20 12 15 7" />
          <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
        </svg>
        Forward
      </button>
      {open && popoverPos && createPortal(
        <div
          ref={popoverRef}
          className="sb-floating-surface"
          style={{
            // Portalled to document.body to escape the virtualizer's
            // `transform: translateY` ancestor (which would otherwise
            // clip this `position: fixed` as if it were `absolute`).
            position: 'fixed',
            top: popoverPos.top,
            right: popoverPos.right,
            zIndex: 1200,
            minWidth: '240px',
            maxHeight: '300px',
            overflowY: 'auto',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
          }}
        >
          <div style={{
            padding: '6px 10px 4px',
            fontSize: '10px',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.7px',
            fontWeight: 600,
            borderBottom: '1px solid var(--border)',
          }}>
            Forward to
          </div>
          {others.length === 0 && (
            <div style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: '11.5px', textAlign: 'center' }}>
              No other sessions open. Start another chat to forward.
            </div>
          )}
          {others.map((sess) => (
            <button
              key={sess.id}
              onClick={() => handleForward(sess.id, sess.title)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 10px',
                border: 'none',
                background: 'transparent',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '12px',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ color: 'var(--text-muted)', fontSize: '10px', marginRight: '6px' }}>
                {agentShortLabel(sess.type)}
              </span>
              {sess.title ?? sess.id.slice(0, 8)}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
