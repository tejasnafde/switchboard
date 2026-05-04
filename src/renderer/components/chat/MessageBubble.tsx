import { memo, useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react'
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
import { renderPillBody } from './renderPillBody'
import { parseSlashCommandWrapper, splitSkillMentions } from './slashCommands'
import { SkillChip } from './SkillChip'
import { forkAndOpenSession } from '../../services/forkSession'

interface MessageBubbleProps {
  message: ChatMessage
  /**
   * Conversation id this bubble belongs to. Required for fork-from-message
   * — without it, dual-chat right-clicks on the right panel would silently
   * fork the *left* panel's session (the global activeSessionId). When
   * undefined we fall back to activeSessionId, which is fine for the
   * single-pane case.
   */
  sessionId?: string
  /**
   * Lowercased set of slash-command names registered for this session
   * (built-ins + agent-advertised skills). Used to gate the leading-`/cmd`
   * chip so typos like `/halp` render as plain text instead of
   * masquerading as recognized skills. Undefined while the session's
   * skills haven't been published yet — chip rendering is suppressed
   * rather than risk a false positive.
   */
  knownSkillNames?: Set<string>
  onApproval?: (requestId: string, decision: 'approve' | 'deny', note?: string) => void
  onAnswerQuestion?: (requestId: string, answers: string[][]) => void
  onPlanAction?: (planId: string, action: 'implement' | 'iterate') => void
}

export const MessageBubble = memo(function MessageBubble({ message, sessionId, knownSkillNames, onApproval, onAnswerQuestion, onPlanAction }: MessageBubbleProps) {
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
  // Right-click → Fork popover. Anchored at the click coordinates;
  // dismisses on click-outside / Escape. We resolve the fork's source
  // conversation lazily off `useAgentStore.getState()` at click time so
  // we don't subscribe the bubble to every store change.
  const [forkMenu, setForkMenu] = useState<{ x: number; y: number } | null>(null)
  const [forkBusy, setForkBusy] = useState<false | 'plain' | 'worktree'>(false)
  const [forkError, setForkError] = useState<string | null>(null)
  // After a successful "Fork to worktree" the new branch name flashes
  // briefly at the bottom of the chat — tells the user where their files
  // landed without forcing them to dig into the sidebar's secondary line.
  const [forkToast, setForkToast] = useState<string | null>(null)

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
      const api = window.api
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

  const handleForkRequest = async (withWorktree: boolean = false) => {
    const store = useAgentStore.getState()
    // Prefer the conversation this bubble belongs to (passed from
    // MessageList) over the global activeSessionId — in dual-chat the
    // active id tracks focus, not which panel was right-clicked.
    const sourceId = sessionId ?? store.activeSessionId
    const session = sourceId ? store.sessions.find((s) => s.id === sourceId) : null
    if (!sourceId || !session) {
      setForkError('No active session')
      return
    }
    // Block forking mid-turn — Claude SDK can't safely truncate while it's
    // actively appending to the JSONL, and the user's freshly-typed reply
    // would race the fork's resume anchor.
    if (session.status !== 'idle') {
      setForkError('Cannot fork while a turn is in flight')
      return
    }
    // Translate the clicked message id to a positional index in this
    // session's currently-loaded message array. Position is the only
    // contract that survives a JSONL re-parse on the main side, since
    // JsonlParser regenerates ids on every call.
    const messages = session.messages ?? []
    const upToIndex = messages.findIndex((m) => m.id === message.id)
    if (upToIndex < 0) {
      setForkError('Message not in current session')
      return
    }
    setForkBusy(withWorktree ? 'worktree' : 'plain')
    setForkError(null)
    try {
      const res = await forkAndOpenSession(sourceId, upToIndex, message.id, withWorktree)
      if (!res.ok) {
        setForkError(res.error ?? 'Fork failed')
      } else {
        setForkMenu(null)
        if (res.worktree) {
          setForkToast(`Forked to ${res.worktree.branch}`)
          // Self-dismiss after a beat — toast is informational, not
          // actionable, so a 4s window is plenty for the eye to catch.
          setTimeout(() => setForkToast(null), 4000)
        }
      }
    } catch (err) {
      setForkError(err instanceof Error ? err.message : 'Fork failed')
    } finally {
      setForkBusy(false)
    }
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
      onContextMenu={(e) => {
        // Skip the menu for system / error messages — they aren't fork
        // anchors. Image-lightbox right-click is portal'd to body and
        // doesn't bubble through this handler, so it stays unaffected.
        if (isSystem) return
        e.preventDefault()
        setForkMenu({ x: e.clientX, y: e.clientY })
        setForkError(null)
      }}
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
          }}>
            {message.displayBody && message.pillsMeta ? (
              renderPillBody(message.displayBody, message.pillsMeta)
            ) : (() => {
              // Chipify every `/<known-skill>` mention so a multi-skill
              // prompt like `/deslop then /review` round-trips as two
              // chips. Unwrap the SDK's `<command-message>...
              // </command-args>` XML blob (JSONL reload) before scanning.
              if (!knownSkillNames?.size) return message.content
              const wrapper = parseSlashCommandWrapper(message.content)
              const body = wrapper ? `/${wrapper.name}${wrapper.rest}` : message.content
              const segments = splitSkillMentions(body, knownSkillNames)
              if (!segments.some((s) => s.type === 'skill')) return message.content
              return segments.map((seg, i) =>
                seg.type === 'skill'
                  ? <SkillChip key={i} name={seg.name} />
                  : <span key={i}>{seg.value}</span>,
              )
            })()}
          </div>
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

      {/* Right-click context menu — portal'd to body so it escapes the
          virtualizer's transformed row. Mirrors SlashCommandMenu's
          `sb-floating-surface` look so all our floating menus feel like
          one family. */}
      {forkMenu && createPortal(
        <ForkContextMenu
          x={forkMenu.x}
          y={forkMenu.y}
          busy={forkBusy}
          error={forkError}
          onFork={() => handleForkRequest(false)}
          onForkWorktree={() => handleForkRequest(true)}
          onDismiss={() => setForkMenu(null)}
        />,
        document.body,
      )}
      {forkToast && createPortal(
        <div
          role="status"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1400,
            padding: '8px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
            fontSize: '12.5px',
            color: 'var(--text-primary)',
            pointerEvents: 'none',
          }}
        >
          {forkToast}
        </div>,
        document.body,
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

/**
 * Fork-from-message right-click menu. Anchored at the click coordinates,
 * dismisses on click-outside / Escape. The actual fork work runs in
 * `forkAndOpenSession` via the parent's `onFork` callback so this stays
 * a presentational component (easier to slot more actions in later
 * — Edit message, Retry from here, etc.).
 */
function ForkContextMenu({
  x, y, busy, error, onFork, onForkWorktree, onDismiss,
}: {
  x: number
  y: number
  /** False when idle, otherwise which entry the user just clicked.
   *  Lets us only spinner-out the affected row instead of greying both. */
  busy: false | 'plain' | 'worktree'
  error: string | null
  onFork: () => void
  /** #5: branch off HEAD into a fresh git worktree before opening the fork. */
  onForkWorktree: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Clamp the menu inside the viewport so a right-click near the edge
  // doesn't push it off-screen. We render hidden on first paint, measure
  // synchronously in useLayoutEffect, and reveal on the same frame — that
  // way the user never sees the unclamped position flash before the
  // post-measure correction lands.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 6
    const nx = Math.min(x, window.innerWidth - rect.width - margin)
    const ny = Math.min(y, window.innerHeight - rect.height - margin)
    setPos({ x: Math.max(margin, nx), y: Math.max(margin, ny) })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={ref}
      className="sb-floating-surface"
      style={{
        position: 'fixed',
        top: pos?.y ?? y,
        left: pos?.x ?? x,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 1300,
        minWidth: '200px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
        padding: '4px',
      }}
    >
      <ForkMenuItem
        label={busy === 'plain' ? 'Forking…' : 'Fork from here'}
        disabled={busy !== false}
        onClick={onFork}
        icon={
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="12" cy="20" r="3" />
            <path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" />
            <path d="M12 12v5" />
          </svg>
        }
      />
      <ForkMenuItem
        label={busy === 'worktree' ? 'Creating worktree…' : 'Fork to worktree'}
        disabled={busy !== false}
        onClick={onForkWorktree}
        icon={
          // A small "branch + box" combo evokes "git branch into its own
          // working tree" without screaming for a third-party icon set.
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="9" r="2.5" />
            <path d="M6 8.5v7" />
            <path d="M6 13a6 6 0 0 0 6-6" />
            <rect x="14" y="13" width="8" height="8" rx="1" />
          </svg>
        }
        sublabel="branches off HEAD"
      />
      {error && (
        <div style={{
          padding: '6px 10px',
          fontSize: '11px',
          color: 'var(--danger, #f85149)',
          borderTop: '1px solid var(--border)',
          marginTop: '4px',
        }}>
          {error}
        </div>
      )}
      <div style={{
        padding: '4px 10px 2px',
        fontSize: '10px',
        color: 'var(--text-muted)',
        borderTop: '1px solid var(--border)',
        marginTop: '4px',
      }}>
        Esc to dismiss
      </div>
    </div>
  )
}

/**
 * Single row inside the fork context menu. Pulled out as its own
 * component so adding entries doesn't mean copy-pasting the hover /
 * disabled / icon scaffolding for each.
 */
function ForkMenuItem({
  label, sublabel, icon, disabled, onClick,
}: {
  label: string
  sublabel?: string
  icon: React.ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        background: 'transparent',
        color: disabled ? 'var(--text-muted)' : 'var(--text-primary)',
        cursor: disabled ? 'wait' : 'pointer',
        fontSize: '12.5px',
        textAlign: 'left',
        borderRadius: '4px',
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
        <span>{label}</span>
        {sublabel && (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{sublabel}</span>
        )}
      </span>
    </button>
  )
}
