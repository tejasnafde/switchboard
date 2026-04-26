import { useEffect, useRef, useState, useCallback } from 'react'
import { FEATURE_TOUR_STEPS, TOUR_VERSION, type FeatureTourStep, type TryItAction } from './featureRegistry'

interface FeatureTourModalProps {
  open: boolean
  onClose: () => void
  /** Step index to start at (default 0). Setting state lifts to caller so
   *  Settings → "Play this step" can deep-link a specific clip. */
  startAt?: number
  /** Called when the user clicks a "Try it" pill — caller routes to the
   *  appropriate UI (e.g. focus chat input, open search). */
  onTryIt?: (action: TryItAction) => void
}

/**
 * Onboarding / what's-new modal. Shown automatically on first launch
 * after the tour version bumps (gated by `tour.lastSeenVersion` setting),
 * and replayable from Settings → Tour.
 *
 * The video for each step streams via the `sb-tour://<id>.mp4` custom
 * protocol registered in main. Missing MP4s fall through to the
 * text-only fallback — the modal stays usable while we backfill clips.
 */
export function FeatureTourModal({ open, onClose, startAt = 0, onTryIt }: FeatureTourModalProps) {
  const [idx, setIdx] = useState(startAt)
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (open) {
      setIdx(startAt)
      setVideoFailed(false)
    }
  }, [open, startAt])

  // Reset video error state when step changes; let the next mount try
  // its own MP4. Without this, a single missing MP4 would poison the
  // fallback flag for all subsequent steps.
  useEffect(() => {
    setVideoFailed(false)
  }, [idx])

  const step: FeatureTourStep | undefined = FEATURE_TOUR_STEPS[idx]
  const total = FEATURE_TOUR_STEPS.length
  const isLast = idx === total - 1

  const goNext = useCallback(() => {
    if (isLast) {
      void window.api.settings.set('tour.lastSeenVersion', TOUR_VERSION)
      onClose()
    } else {
      setIdx((i) => Math.min(i + 1, total - 1))
    }
  }, [isLast, onClose, total])

  const goBack = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), [])

  const skip = useCallback(() => {
    void window.api.settings.set('tour.lastSeenVersion', TOUR_VERSION)
    onClose()
  }, [onClose])

  // Keyboard nav: ←/→ steps, Esc dismisses, Enter advances
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skip()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') goNext()
      else if (e.key === 'ArrowLeft') goBack()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, goNext, goBack, skip])

  if (!open || !step) return null

  return (
    <div
      onClick={skip}
      style={{
        position: 'fixed',
        inset: 0,
        // Heavy dim + strong blur so the modal reads as foreground even
        // under the translucent/vibrancy theme (where --bg-secondary
        // carries alpha and would let the chat bleed through).
        background: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(14px) saturate(140%)',
        WebkitBackdropFilter: 'blur(14px) saturate(140%)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '720px',
          maxWidth: 'calc(100vw - 80px)',
          // Hardcoded opaque shade — DON'T use var(--bg-secondary) here.
          // On the translucent theme that token is rgba(...) and the
          // modal becomes see-through against the dimmed chat behind.
          // This matches our dark theme value but stays solid in every
          // theme.
          background: '#16181d',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 32px 80px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.03) inset',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', fontWeight: 600 }}>
            Step {idx + 1} of {total}
          </div>
          <button
            type="button"
            onClick={skip}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Skip tour
          </button>
        </div>

        {/* Video / fallback */}
        <div style={{
          background: 'var(--bg)',
          aspectRatio: '16 / 9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}>
          {!videoFailed ? (
            <video
              key={step.id}
              ref={videoRef}
              autoPlay
              muted
              loop
              playsInline
              onError={() => setVideoFailed(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              src={`sb-tour://${step.id}.mp4`}
            />
          ) : (
            <div style={{
              padding: '40px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '13px',
              lineHeight: 1.6,
            }}>
              <div style={{ fontSize: '32px', marginBottom: '10px', opacity: 0.5 }}>▶</div>
              <div>Clip not yet available — see description below.</div>
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px' }}>
          <div style={{
            fontSize: '17px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: '8px',
          }}>
            {step.title}
          </div>
          <div style={{
            fontSize: '13.5px',
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
          }}>
            {step.description}
          </div>

          {step.tryIt && onTryIt && (
            <button
              type="button"
              onClick={() => {
                onTryIt(step.tryIt!)
                void window.api.settings.set('tour.lastSeenVersion', TOUR_VERSION)
                onClose()
              }}
              style={{
                marginTop: '14px',
                padding: '6px 14px',
                background: 'var(--accent-bg, rgba(138, 180, 255, 0.15))',
                border: '1px solid var(--accent)',
                color: 'var(--accent)',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try it →
            </button>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
        }}>
          {/* Step dots */}
          <div style={{ display: 'flex', gap: '6px' }}>
            {FEATURE_TOUR_STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`Go to step ${i + 1}`}
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  background: i === idx ? 'var(--accent)' : 'var(--border-strong, var(--border))',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={goBack}
              disabled={idx === 0}
              style={{
                padding: '7px 14px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: '5px',
                color: idx === 0 ? 'var(--text-muted)' : 'var(--text-secondary)',
                fontSize: '12.5px',
                cursor: idx === 0 ? 'default' : 'pointer',
              }}
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={goNext}
              style={{
                padding: '7px 16px',
                background: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: '5px',
                color: 'var(--bg)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {isLast ? 'Done' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
