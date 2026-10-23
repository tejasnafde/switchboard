/**
 * Update toast, rendered app-level in App.tsx. Appears bottom-right when the
 * auto-updater reports `downloaded`, with an OS notification when the window
 * is not in front. "Restart" quits into the new version; "Later" hides it
 * until the next check reports the download again (see update-toast-policy).
 * After a restart into a new version it says "Updated to" once.
 */
import { useEffect, useState, useCallback, type CSSProperties } from 'react'
import { releaseNotesUrl, type UpdateStatus } from '@shared/update-status'
import { hiddenUpdateToast, updateToastAfter } from './update-toast-policy'
import { notifyUpdateReady } from '../services/notifications'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('component:update-toast')

const toastStyle: CSSProperties = {
  position: 'fixed',
  bottom: 36,
  right: 16,
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  borderRadius: '12px',
  padding: '10px 14px',
  zIndex: 2000,
  maxWidth: '360px',
}

const labelStyle: CSSProperties = { fontSize: '12.5px', color: 'var(--text-primary)' }

const primaryButtonStyle: CSSProperties = {
  padding: '5px 12px',
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: '5px',
  color: 'var(--bg)',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  textDecoration: 'none',
}

const secondaryButtonStyle: CSSProperties = {
  padding: '5px 12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: '5px',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  cursor: 'pointer',
}

export function UpdateToast() {
  const [toast, setToast] = useState(hiddenUpdateToast)
  const [updatedTo, setUpdatedTo] = useState<string | null>(null)

  useEffect(() => {
    let notified: string | null = null
    const apply = (status: UpdateStatus) => {
      setToast((prev) => updateToastAfter(prev, status))
      if (status.kind !== 'downloaded' || status.version === notified) return
      const show = () => setToast({ version: status.version, visible: true })
      notifyUpdateReady(status.version, show)
        .then((shown) => {
          if (shown) notified = status.version
        })
        .catch((err) => log.warn('update notification failed', err))
    }
    const unsubscribe = window.api.app.onUpdateStatus(apply)
    // A renderer that mounts after the download (a reload) still sees it.
    window.api.app
      .getUpdateStatus()
      .then(apply)
      .catch((err) => log.warn('reading the update status failed', err))
    window.api.app
      .takeUpdatedNotice()
      .then((version) => version && setUpdatedTo(version))
      .catch((err) => log.warn('reading the updated notice failed', err))
    return unsubscribe
  }, [])

  const restart = useCallback(() => {
    try {
      window.api.app.quitAndInstall()
    } catch (err) {
      log.error('quitAndInstall failed', err)
    }
  }, [])

  if (!toast.visible && updatedTo) {
    return (
      <div className="sb-glass-toast" role="status" style={toastStyle}>
        <span style={labelStyle}>Updated to v{updatedTo}</span>
        <a href={releaseNotesUrl(updatedTo)} target="_blank" rel="noreferrer" style={primaryButtonStyle}>
          Release notes
        </a>
        <button type="button" onClick={() => setUpdatedTo(null)} style={secondaryButtonStyle}>
          Dismiss
        </button>
      </div>
    )
  }
  if (!toast.visible) return null

  return (
    <div className="sb-glass-toast" style={toastStyle}>
      <span style={labelStyle}>Update {toast.version} ready</span>
      <button type="button" onClick={restart} style={primaryButtonStyle}>
        Restart
      </button>
      <button type="button" onClick={() => setToast({ ...toast, visible: false })} style={secondaryButtonStyle}>
        Later
      </button>
    </div>
  )
}
