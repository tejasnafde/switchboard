/**
 * The context chip viewer: a click (or Enter on a selected chip) shows the
 * exact text the chip expanded to. Terminal and file text is monospace with
 * line numbers (a terminal opens at its end, error lines tinted); messages and
 * review context wrap. Copy, or Cmd+C with nothing selected, copies it all.
 * "Go to source" is offered only when the source resolves; otherwise, or once
 * an open does not land, a quiet note says this is the text that was sent.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog'
import { Button } from '../../ui/button'
import { formatBinding } from '@shared/shortcuts'
import { isErrorLine, type PillChipKind, type PillChipModel } from '../../../services/pill-chip-model'
import { openPillTarget, pillSourceAction } from '../../../services/pill-chip-open'
import { createRendererLogger } from '../../../logger'

const log = createRendererLogger('chat:pill-viewer')

/** How long the Copy button says "Copied". */
export const COPIED_MS = 1500

const MONO_KINDS: ReadonlySet<PillChipKind> = new Set(['terminal', 'file'])

const KBD_CLASS =
  'mr-[3px] rounded-[3px] bg-[var(--bg-tertiary)] px-[4px] text-[10px] text-[var(--text-secondary)] [font-family:var(--font-mono)]'

const stop = (e: SyntheticEvent): void => e.stopPropagation()

const ICON = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  className: 'h-[13px] w-[13px] shrink-0',
} as const

/** The note shown when there is no source to go to. */
export function viewerNote(kind: PillChipKind, sent: boolean): string {
  if (!sent) return 'This is the text that will be sent with your message.'
  if (kind === 'terminal') return 'The pane has closed. This is the output that was sent.'
  return 'This is the text that was sent with your message.'
}

export function PillChipViewer({
  model,
  icon,
  tintStyle,
  sessionId,
  sent,
  open,
  onOpenChange,
}: {
  model: PillChipModel
  icon: ReactNode
  tintStyle: CSSProperties
  /** The chat the chip sits in. */
  sessionId: string | null
  /** A chip in a sent bubble, not the composer. */
  sent: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const text = model.lines.join('\n')
  const mono = MONO_KINDS.has(model.kind)
  const [sourceMissed, setSourceMissed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [going, setGoing] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const action = sourceMissed ? null : pillSourceAction(model.target, sessionId)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )
  // A terminal opens at its end, where the failure usually is.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!open || model.kind !== 'terminal' || !body) return
    body.scrollTop = body.scrollHeight
    setScrolled(body.scrollHeight > body.clientHeight)
  }, [open, model.kind])

  const copy = (): void => {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      log.warn('clipboard unavailable for the chip viewer')
      return
    }
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS)
      },
      (err: unknown) => log.warn('chip viewer copy failed', { bytes: new TextEncoder().encode(text).length, err }),
    )
  }

  const goToSource = (): void => {
    if (!model.target || going) return
    setGoing(true)
    void openPillTarget(model.target, sessionId)
      .then((opened) => {
        if (opened) onOpenChange(false)
        else setSourceMissed(true)
      })
      .catch((err: unknown) => {
        log.warn('chip viewer go to source failed', err)
        setSourceMissed(true)
      })
      .finally(() => setGoing(false))
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key.toLowerCase() !== 'c' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString()) return
    e.preventDefault()
    copy()
  }

  const subtitle = [model.source, model.detail].filter(Boolean).join(' · ')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-pill-viewer={model.kind}
        overlayClassName="z-[1100]"
        onKeyDown={onKeyDown}
        // The dialog is portalled but still a React child of the chip: keep its
        // events from reaching the bubble's or the composer's handlers.
        onClick={stop}
        onPointerDown={stop}
        onMouseDown={stop}
        onContextMenu={stop}
        // A chip is not a tab stop: focus the dialog itself, not its first button.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
        tabIndex={-1}
        style={tintStyle}
        className="sb-floating-surface inset-x-0 top-[28px] z-[1100] mx-auto flex max-h-[calc(100vh-56px)] w-[min(620px,calc(100vw-40px))] flex-col overflow-hidden rounded-[10px] border border-solid border-[var(--border)] text-left text-[var(--text-primary)] [font-family:var(--font-sans)]"
      >
        <div className="flex items-center gap-[8px] border-0 border-b border-solid border-[var(--border)] py-[10px] pl-[14px] pr-[12px]">
          <span className="grid h-[24px] w-[24px] shrink-0 place-items-center rounded-[6px] bg-[color-mix(in_srgb,var(--chip-tint)_14%,transparent)] text-[var(--chip-tint)]">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="m-0 truncate text-[13px] font-semibold">{model.name}</DialogTitle>
            <DialogDescription className="m-0 mt-px truncate text-[11.5px] text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]">
              {subtitle}
              {model.where && (
                <>
                  {' · '}
                  <span className="text-[10.5px] text-[var(--text-muted)] [font-family:var(--font-mono)]">
                    {model.where}
                  </span>
                </>
              )}
            </DialogDescription>
          </div>
          {action && (
            <Button variant="outline" size="sm" data-pill-go-to-source disabled={going} onClick={goToSource}>
              <svg {...ICON}>
                <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-9V4H6" />
              </svg>
              {action}
            </Button>
          )}
          {text && (
            <Button
              variant="outline"
              size="sm"
              data-pill-copy
              onClick={copy}
              className={copied ? 'text-[var(--success)] hover:text-[var(--success)]' : undefined}
            >
              {copied ? (
                <svg {...ICON}>
                  <path d="M3 8.5l3 3 7-7" />
                </svg>
              ) : (
                <svg {...ICON}>
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                  <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
                </svg>
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={() => onOpenChange(false)}>
            <svg {...ICON}>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </Button>
        </div>
        {!action && (
          <div
            data-pill-viewer-note
            className="flex items-center gap-[6px] border-0 border-b border-solid border-[var(--border)] bg-[color-mix(in_srgb,var(--text-primary)_3%,transparent)] px-[14px] py-[7px] text-[11.5px] text-[var(--text-secondary)]"
          >
            <svg {...ICON} className="h-[12px] w-[12px] shrink-0 text-[var(--text-muted)]">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7.5v3.5M8 5v.01" />
            </svg>
            {viewerNote(model.kind, sent)}
          </div>
        )}
        {text && (
          <div ref={bodyRef} data-pill-viewer-body className="min-h-0 flex-1 overflow-auto bg-[var(--bg-primary)]">
            {mono ? (
              <pre className="m-0 py-[8px] text-[12px] leading-[1.6] [font-family:var(--font-mono)]">
                {model.lines.map((line, i) => (
                  <div key={i} className="flex">
                    <i className="box-content w-[4.5ch] shrink-0 select-none pr-[12px] text-right not-italic text-[var(--text-muted)] opacity-70 [font-variant-numeric:tabular-nums]">
                      {model.firstLine + i}
                    </i>
                    <span
                      data-error-line={(model.kind === 'terminal' && isErrorLine(line)) || undefined}
                      className="whitespace-pre-wrap break-all pr-[14px] data-[error-line=true]:text-[var(--error)]"
                    >
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </pre>
            ) : (
              <div className="whitespace-pre-wrap break-words px-[16px] py-[14px] text-[13px] leading-[1.6]">
                {text}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-[14px] border-0 border-t border-solid border-[var(--border)] px-[14px] py-[8px] text-[11px] text-[var(--text-muted)]">
          {scrolled && <span>Showing the end, scroll up for all {model.lines.length}</span>}
          {model.kind === 'file' && text && sent && <span>As sent; the file may have changed since</span>}
          <span className="ml-auto flex gap-[14px]">
            {text && (
              <span>
                <kbd className={KBD_CLASS}>{formatBinding('mod+c')}</kbd>copy all
              </span>
            )}
            <span>
              <kbd className={KBD_CLASS}>esc</kbd>close
            </span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
