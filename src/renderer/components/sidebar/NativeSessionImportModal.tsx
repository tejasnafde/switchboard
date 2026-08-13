import type { SessionSummary } from '@shared/types'

interface Props {
  projectName: string
  candidates: SessionSummary[]
  importingId: string | null
  error: string | null
  onImport: (session: SessionSummary) => void
  onClose: () => void
}

export function NativeSessionImportModal({
  projectName,
  candidates,
  importingId,
  error,
  onImport,
  onClose,
}: Props) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal-content"
        aria-modal="true"
        aria-label="Import native conversations"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ width: 'min(680px, calc(100vw - 32px))', maxHeight: '76vh' }}
      >
        <header style={{ padding: '18px 20px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '.08em', textTransform: 'uppercase' }}>
            Recovery inventory · {projectName}
          </div>
          <h2 style={{ margin: '6px 0 4px', fontSize: 18, fontWeight: 600 }}>Import a native conversation</h2>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.5 }}>
            Provider files stay outside the sidebar until you choose one. Delegated agents remain nested under their parent.
          </p>
        </header>

        <div style={{ overflowY: 'auto', padding: '8px' }}>
          {candidates.length === 0 ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
              No native transcripts found for this project.
            </div>
          ) : candidates.map((session) => {
            const importable = Boolean(session.filePath)
            const delegated = session.nativeRole === 'subagent' || session.nativeRole === 'utility'
            const role = session.nativeRole === 'subagent'
              ? `Subagent${session.depth != null ? ` · depth ${session.depth}` : ''}`
              : session.nativeRole === 'utility' ? 'Utility run' : 'Conversation'
            return (
              <div
                key={`${session.source}:${session.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '76px minmax(0, 1fr) auto',
                  gap: 12,
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderBottom: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
                  opacity: importable ? 1 : 0.62,
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--accent)' }}>
                  {session.source === 'codex' ? 'CODEX' : 'CLAUDE'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                    {session.title}
                  </div>
                  <div style={{ marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                    {role} · {session.id.slice(0, 18)}
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
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Unavailable</span>
                )}
              </div>
            )
          })}
        </div>

        <footer style={{ minHeight: 42, padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--danger)', fontSize: 11.5 }}>{error}</span>
          <button className="settings-button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  )
}
