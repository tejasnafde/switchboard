/**
 * Cursor-style update toast, rendered app-level in App.tsx. Appears
 * bottom-right when the auto-updater reports `downloaded`. "Restart"
 * quits into the new version; "Later" hides it for this session (per
 * version, so a newer download re-surfaces it).
 */
import { useEffect, useState, useCallback } from 'react'
import type { UpdateStatus } from '@shared/update-status'
import { shouldShowUpdateToast } from './updateToastPolicy'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('component:update-toast')

export function UpdateToast() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => window.api.app.onUpdateStatus(setStatus), [])

  const restart = useCallback(() => {
    try {
      window.api.app.quitAndInstall()
    } catch (err) {
      log.error('quitAndInstall failed', err)
    }
  }, [])

  if (status.kind !== 'downloaded') return null
  if (!shouldShowUpdateToast(status, dismissedVersion)) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 36,
        right: 16,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        // Frosted glass: a translucent fill plus a blur of what is behind it,
        // a hairline top highlight for the lit edge, and a saturate() so the
        // colours showing through stay lively instead of washing out grey.
        background: 'color-mix(in srgb, var(--bg-surface) 62%, transparent)',
        backdropFilter: 'blur(22px) saturate(180%)',
        WebkitBackdropFilter: 'blur(22px) saturate(180%)',
        border: '1px solid color-mix(in srgb, var(--border) 65%, transparent)',
        borderRadius: '12px',
        padding: '10px 14px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)',
        zIndex: 2000,
        maxWidth: '360px',
      }}
    >
      <span style={{ fontSize: '12.5px', color: 'var(--text-primary)' }}>
        Update {status.version} ready
      </span>
      <button
        type="button"
        onClick={restart}
        style={{
          padding: '5px 12px',
          background: 'var(--accent)',
          border: '1px solid var(--accent)',
          borderRadius: '5px',
          color: 'var(--bg)',
          fontSize: '12px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Restart
      </button>
      <button
        type="button"
        onClick={() => setDismissedVersion(status.version)}
        style={{
          padding: '5px 12px',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '5px',
          color: 'var(--text-secondary)',
          fontSize: '12px',
          cursor: 'pointer',
        }}
      >
        Later
      </button>
    </div>
  )
}
