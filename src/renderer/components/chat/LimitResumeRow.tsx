/**
 * The Limited row of any chat (flag `limit_auto_resume`): "Usage limit.
 * Resumes 15:40." with Resume now and Cancel auto-resume while a resume is
 * armed, or why none is. Read from the backend on open and on every
 * `limit-resume.changed`, so every client shows the same row.
 */
import { useEffect, useState } from 'react'
import { limitStateText, type LimitState } from '@shared/limit-resume'
import { Button } from '../ui/button'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:limit-resume')

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function LimitResumeRow({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<LimitState>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    const api = window.api.provider
    let live = true
    const read = () =>
      api
        .limitResumeGet(sessionId)
        .then((next) => {
          if (live) setState(next)
        })
        .catch((err: unknown) => log.warn('reading the Limited row failed', err))
    void read()
    // The event names the live id, which can differ from this chat's: re-read on any.
    const off = api.onEvent((event) => {
      if (event.type === 'limit-resume.changed') {
        setNote(null)
        void read()
      }
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])

  const text = limitStateText(state, clock)
  if (!text) return null

  const act = async (action: 'now' | 'cancel') => {
    setBusy(true)
    setNote(null)
    try {
      const api = window.api.provider
      if (action === 'cancel') await api.limitResumeCancel(sessionId)
      else {
        const result = await api.limitResumeNow(sessionId)
        if (!result.ok) setNote(result.message)
      }
    } catch (err) {
      log.warn(`${action} of the auto-resume failed`, err)
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-limit-resume={state.kind}
      className="mx-6 mb-2 flex items-center gap-[8px] rounded-[6px] border border-[var(--border)] px-[10px] py-[6px] text-[12px] text-[var(--text-secondary)]"
    >
      <span role="status" aria-live="polite" className="flex-1">
        {text}
        {note ? ` ${note}` : ''}
      </span>
      {state.kind === 'armed' && (
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('now')}>
            Resume now
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('cancel')}>
            Cancel auto-resume
          </Button>
        </>
      )}
    </div>
  )
}
