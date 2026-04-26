import { useMemo, useRef, useEffect } from 'react'
import { marked } from 'marked'
import type { PlanAttachment } from '@shared/types'

interface PlanCardProps {
  plan: PlanAttachment
  onApprove?: () => void
  onReject?: () => void
}

/**
 * Displays a proposed plan (from agent's ExitPlanMode).
 * Renders markdown + Accept / Reject actions.
 */
export function PlanCard({ plan, onApprove, onReject }: PlanCardProps) {
  const rendered = useMemo(() => marked.parse(plan.markdown, { async: false }) as string, [plan.markdown])
  const ref = useRef<HTMLDivElement>(null)

  // Attach per-code-block copy buttons (same as MessageBubble)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector(':scope > .code-copy-btn')) return
      pre.style.position = 'relative'
      const btn = document.createElement('button')
      btn.className = 'code-copy-btn'
      btn.type = 'button'
      btn.textContent = 'Copy'
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        const code = pre.querySelector('code')
        const text = code?.textContent ?? pre.textContent ?? ''
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied'
          btn.classList.add('copied')
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
        }).catch(() => {})
      })
      pre.appendChild(btn)
    })
  }, [rendered])

  return (
    <div
      style={{
        marginTop: '8px',
        border: '1px solid var(--accent)',
        borderRadius: 'var(--radius)',
        background: 'var(--accent-subtle)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(88, 166, 255, 0.08)',
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span style={{
          fontSize: '11px',
          fontWeight: 600,
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
        }}>
          Proposed Plan
        </span>
      </div>

      {/* Plan markdown */}
      <div
        ref={ref}
        className="markdown-content"
        style={{ padding: '10px 14px', fontSize: '13px' }}
        dangerouslySetInnerHTML={{ __html: rendered }}
      />

      {/* Actions */}
      {(onApprove || onReject) && (
        <div style={{
          display: 'flex',
          gap: '8px',
          padding: '8px 12px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(88, 166, 255, 0.04)',
        }}>
          {onApprove && (
            <button
              onClick={onApprove}
              style={{
                padding: '5px 14px',
                borderRadius: '4px',
                border: 'none',
                background: 'var(--accent)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '11.5px',
                fontWeight: 600,
              }}
            >
              Implement Plan
            </button>
          )}
          {onReject && (
            <button
              onClick={onReject}
              style={{
                padding: '5px 14px',
                borderRadius: '4px',
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '11.5px',
              }}
            >
              Iterate
            </button>
          )}
        </div>
      )}
    </div>
  )
}
