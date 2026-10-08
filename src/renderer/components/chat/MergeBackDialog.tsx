/**
 * Send a fork's work back to its parent chat (`shared/merge-back.ts`). The
 * backend builds the summary; the user reads and edits it here, and Send
 * stores it as a pending card in the parent, which goes to the parent's agent
 * with the next message there. The same dialog edits that card.
 */
import { useEffect, useRef, useState } from 'react'
import type { MergeBackActionResult, MergeBackPreview, MergeBackToken } from '@shared/merge-back'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:merge-back')

const OLD_BACKEND = 'The Switchboard running this chat is too old to send back. Update it, then try again.'

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return /no handler/i.test(message) ? OLD_BACKEND : message
}

type Mode =
  | { kind: 'send'; forkSessionId: string; parentTitle: string }
  | { kind: 'edit'; parentSessionId: string; mergeBackId: string; forkTitle: string; text: string }

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; token: MergeBackToken | null; replacesPending: boolean; note: string | null }
  | { kind: 'blocked'; message: string }

function describeReady(preview: Extract<MergeBackPreview, { status: 'ready' }>): string {
  const turns = `${preview.turns} turn${preview.turns === 1 ? '' : 's'}`
  const files = preview.files.length + preview.moreFiles
  return `${turns}${preview.omittedTurns > 0 ? ` (${preview.omittedTurns} oldest left out to fit)` : ''}`
    + ` · ${files} file${files === 1 ? '' : 's'} changed`
}

export function MergeBackDialog({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const [load, setLoad] = useState<Load>(() => mode.kind === 'edit'
    ? { kind: 'ready', token: null, replacesPending: false, note: null }
    : { kind: 'loading' })
  const [text, setText] = useState(mode.kind === 'edit' ? mode.text : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const forkSessionId = mode.kind === 'send' ? mode.forkSessionId : null

  useEffect(() => {
    if (!forkSessionId) return
    // The dialog can close (or open for another fork) before the preview lands.
    let current = true
    window.api.provider.mergeBackPreview(forkSessionId).then((preview) => {
      if (!current) return
      if (preview.status !== 'ready') {
        setLoad({ kind: 'blocked', message: preview.message })
        return
      }
      setText(preview.text)
      setLoad({ kind: 'ready', token: preview.token, replacesPending: preview.replacesPending, note: describeReady(preview) })
      requestAnimationFrame(() => textRef.current?.focus())
    }).catch((err: unknown) => {
      log.warn('merge-back preview failed', err)
      if (current) setLoad({ kind: 'blocked', message: errorText(err) })
    })
    return () => { current = false }
  }, [forkSessionId])

  const submit = async () => {
    if (load.kind !== 'ready' || saving) return
    setSaving(true)
    setError(null)
    try {
      let result: MergeBackActionResult
      if (mode.kind === 'send') {
        if (!load.token) return
        result = await window.api.provider.mergeBackSend(mode.forkSessionId, text, load.token)
      } else {
        result = await window.api.provider.mergeBackEdit(mode.parentSessionId, mode.mergeBackId, text)
      }
      if (result.ok) onClose()
      else setError(result.message)
    } catch (err) {
      log.warn(`merge-back ${mode.kind} failed`, err)
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const title = mode.kind === 'send'
    ? `Send back to "${mode.parentTitle}"`
    : `Edit the summary from fork "${mode.forkTitle}"`

  return (
    // A send in flight cannot be called back, so the dialog stays until it settles.
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent
        data-testid="merge-back-dialog"
        onOpenAutoFocus={(e) => {
          // Until the preview lands there is no textarea: let Radix focus the
          // first control; the preview moves focus to the textarea when ready.
          if (!textRef.current) return
          e.preventDefault()
          textRef.current.focus()
        }}
        overlayClassName="z-[1300]"
        className="sb-floating-surface inset-x-0 top-[12vh] z-[1300] mx-auto flex max-h-[76vh] w-[min(680px,92vw)] flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
      >
        <DialogTitle className="border-b border-[var(--border)] px-[14px] py-[10px] text-[12px] font-[600] text-[var(--text-secondary)]">
          {title}
        </DialogTitle>
        <DialogDescription className="px-[14px] pt-[10px] text-[12px] text-[var(--text-muted)]">
          {mode.kind === 'send'
            ? 'The parent chat keeps this summary and gives it to its agent with your next message there, as context. Nothing is merged in git.'
            : 'This goes to the agent with your next message in this chat.'}
        </DialogDescription>
        {load.kind === 'loading' && (
          <div className="px-[14px] py-[16px] text-[12px] text-[var(--text-muted)]">Building the summary…</div>
        )}
        {load.kind === 'blocked' && (
          <div role="alert" className="px-[14px] py-[16px] text-[12px] text-[var(--text-secondary)]">{load.message}</div>
        )}
        {load.kind === 'ready' && (
          <div className="flex min-h-0 flex-1 flex-col gap-[8px] px-[14px] py-[10px]">
            {load.note && <div className="text-[12px] text-[var(--text-muted)]">{load.note}</div>}
            {load.replacesPending && (
              <div className="text-[12px] text-[var(--text-secondary)]">
                A summary from this fork is already waiting in the parent. Sending replaces it.
              </div>
            )}
            <textarea
              ref={textRef}
              aria-label="Summary"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
              }}
              className="min-h-[240px] flex-1 resize-none rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[9px] py-[7px] text-[12px] leading-[1.45] [font-family:var(--font-mono)] text-[var(--text-primary)] outline-none"
            />
            {error && <div role="alert" className="text-[12px] text-[var(--error)]">{error}</div>}
          </div>
        )}
        <div className="flex justify-end gap-[6px] border-t border-[var(--border)] px-[14px] py-[10px]">
          <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>Cancel</Button>
          {load.kind === 'ready' && (
            <Button size="sm" disabled={saving || !text.trim()} onClick={() => void submit()}>
              {mode.kind === 'send' ? (saving ? 'Sending…' : 'Send back') : (saving ? 'Saving…' : 'Save')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export type MergeBackDialogMode = Mode
