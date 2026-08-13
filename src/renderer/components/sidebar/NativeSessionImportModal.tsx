import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@shared/types'

interface Props {
  projectName: string
  candidates: SessionSummary[]
  importingId: string | null
  error: string | null
  onImport: (session: SessionSummary) => void
  onClose: () => void
}

function recoveryRole(session: SessionSummary): string {
  if (session.nativeRole === 'subagent') {
    return `Subagent${session.depth != null ? ` · depth ${session.depth}` : ''}`
  }
  if (session.nativeRole === 'utility') return 'Utility run'
  return 'Conversation'
}

export function filterRecoveryCandidates(
  candidates: SessionSummary[],
  query: string,
): SessionSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return candidates
  return candidates.filter((session) => [
    session.title,
    session.id,
    session.source === 'codex' ? 'codex' : session.source === 'claude-code' ? 'claude' : session.source,
    recoveryRole(session),
  ].some((value) => value.toLowerCase().includes(needle)))
}

export function NativeSessionImportModal({
  projectName,
  candidates,
  importingId,
  error,
  onImport,
  onClose,
}: Props) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const filtered = useMemo(
    () => filterRecoveryCandidates(candidates, query),
    [candidates, query],
  )

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || importingId) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [importingId, onClose])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ))
      if (controls.length === 0) return
      const current = controls.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current === controls.length - 1 ? 0 : current + 1)
      event.preventDefault()
      controls[next].focus()
    }
    document.addEventListener('keydown', trapFocus, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', trapFocus, true)
      previous?.focus()
    }
  }, [])

  const resultLabel = `${filtered.length} ${filtered.length === 1 ? 'transcript' : 'transcripts'}`

  return (
    <div
      className="recovery-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !importingId) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="recovery-modal-content sb-floating-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-modal-title"
      >
        <header className="recovery-modal-header">
          <div className="recovery-modal-heading">
            <div className="recovery-modal-eyebrow">Recovery inventory · {projectName}</div>
            <h2 id="recovery-modal-title">Import a native conversation</h2>
            <p>Provider files stay outside the sidebar until you choose one. Delegated agents remain nested under their parent.</p>
          </div>
          <button
            type="button"
            className="recovery-modal-close"
            aria-label="Close recovery inventory"
            disabled={importingId !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="recovery-modal-toolbar">
          <input
            ref={searchRef}
            className="recovery-modal-search"
            type="search"
            aria-label="Search native transcripts"
            placeholder={`Search ${candidates.length} transcripts by title, provider, role, or ID`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="recovery-modal-count" aria-live="polite">{resultLabel}</span>
        </div>

        <div className="recovery-modal-results">
          {filtered.length === 0 ? (
            <div className="recovery-modal-empty">
              {candidates.length === 0
                ? 'No native transcripts found for this project.'
                : `No transcripts match “${query.trim()}”.`}
            </div>
          ) : filtered.map((session) => {
            const importable = Boolean(session.filePath)
            const delegated = session.nativeRole === 'subagent' || session.nativeRole === 'utility'
            return (
              <div
                className="recovery-modal-row"
                key={`${session.source}:${session.id}`}
                data-unavailable={!importable || undefined}
              >
                <span className="recovery-modal-provider">
                  {session.source === 'codex' ? 'CODEX' : 'CLAUDE'}
                </span>
                <div className="recovery-modal-summary">
                  <div className="recovery-modal-title" title={session.title}>{session.title}</div>
                  <div className="recovery-modal-meta">
                    {recoveryRole(session)} · {session.id}
                  </div>
                </div>
                {importable ? (
                  <button
                    className="settings-button"
                    disabled={importingId !== null}
                    onClick={() => onImport(session)}
                  >
                    {importingId === session.id ? 'Importing…' : delegated ? 'Promote' : 'Import'}
                  </button>
                ) : (
                  <span className="recovery-modal-unavailable">Unavailable</span>
                )}
              </div>
            )
          })}
        </div>

        <footer className="recovery-modal-footer">
          <span className="recovery-modal-error" aria-live="assertive">{error}</span>
          <span>Esc to close</span>
        </footer>
      </section>
    </div>
  )
}
