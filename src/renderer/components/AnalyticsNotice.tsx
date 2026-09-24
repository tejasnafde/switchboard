/**
 * One-time first-launch line about anonymous usage counts. Same glass style
 * as UpdateToast, bottom-left so the two never overlap. "Turn off" flips the
 * setting and dismisses; "OK" only dismisses. Either way the notice is not
 * shown again (`analytics.noticeSeen`).
 */
import { useEffect, useState, useCallback } from 'react'
import {
  markAnalyticsNoticeSeen,
  setAnalyticsEnabled,
  shouldShowAnalyticsNotice,
} from '../services/analytics-pref'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('component:analytics-notice')

export function AnalyticsNotice() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    shouldShowAnalyticsNotice().then(setVisible).catch((err) => log.warn('notice check failed', err))
  }, [])

  const dismiss = useCallback(async (turnOff: boolean) => {
    setVisible(false)
    if (turnOff) await setAnalyticsEnabled(false)
    await markAnalyticsNoticeSeen()
  }, [])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 36,
        left: 16,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        background: 'color-mix(in srgb, var(--bg-surface) 62%, transparent)',
        backdropFilter: 'blur(22px) saturate(180%)',
        WebkitBackdropFilter: 'blur(22px) saturate(180%)',
        border: '1px solid color-mix(in srgb, var(--border) 65%, transparent)',
        borderRadius: '12px',
        padding: '10px 14px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)',
        zIndex: 2000,
        maxWidth: '460px',
      }}
    >
      <span style={{ fontSize: '12px', color: 'var(--text-primary)', lineHeight: 1.4 }}>
        Switchboard sends anonymous usage counts (launches, sessions, crashes) with a random install id and nothing else.
      </span>
      <button
        type="button"
        onClick={() => void dismiss(true)}
        style={{
          padding: '5px 12px',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '5px',
          color: 'var(--text-secondary)',
          fontSize: '12px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Turn off
      </button>
      <button
        type="button"
        onClick={() => void dismiss(false)}
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
        OK
      </button>
    </div>
  )
}
