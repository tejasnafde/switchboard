import type {
  WorktreeCreationPhase,
  WorktreeCreationRecoveryAction,
  WorktreeCreationSnapshot,
} from '../../../shared/worktree-creation'

const PHASE_LABELS: Record<WorktreeCreationPhase, string> = {
  pending: 'Preparing',
  materializing: 'Creating worktree',
  configuring: 'Configuring sparse checkout',
  linking: 'Linking conversation or card',
  awaiting_setup_decision: 'Waiting for setup choice',
  provisioning: 'Starting workspace',
  ready: 'Ready',
}

const ACTION_LABELS: Record<WorktreeCreationRecoveryAction, string> = {
  choose_setup_run: 'Run setup',
  choose_setup_skip: 'Skip setup',
  retry: 'Retry',
  cancel: 'Cancel',
  retain: 'Retain worktree',
  remove: 'Remove worktree',
  start_in_project: 'Start in project',
}

interface Props {
  snapshot: WorktreeCreationSnapshot
  detail?: string
  disconnected?: boolean
  onAction?: (action: WorktreeCreationRecoveryAction) => void
}

export function WorktreeCreationProgress({
  snapshot,
  detail,
  disconnected = false,
  onAction,
}: Props): React.ReactElement {
  const retained = snapshot.status === 'cleanup_required'
  const message = disconnected
    ? `Reconnect to continue tracking creation ${snapshot.creationId}.`
    : snapshot.error?.message ?? detail

  return (
    <section
      aria-live="polite"
      data-worktree-creation-id={snapshot.creationId}
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        padding: '10px 12px',
        background: 'var(--bg-secondary)',
        color: 'var(--text-primary)',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong>{PHASE_LABELS[snapshot.phase]}</strong>
        <code style={{ color: 'var(--text-muted)', fontSize: 10 }}>{snapshot.creationId}</code>
      </div>
      {message && <div style={{ marginTop: 5, color: 'var(--text-secondary)' }}>{message}</div>}
      {retained && (
        <div style={{ marginTop: 5, color: 'var(--text-secondary)' }}>
          The worktree was retained because setup or startup may have modified it.
        </div>
      )}
      {snapshot.recoveryActions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {snapshot.recoveryActions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={!onAction}
              onClick={() => onAction?.(action)}
              style={{
                border: '1px solid var(--border-default)',
                borderRadius: 6,
                padding: '4px 8px',
                background: 'var(--bg-tertiary)',
                color: 'inherit',
                cursor: onAction ? 'pointer' : 'default',
              }}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
