import { useEffect, useRef } from 'react'

export type NewChatCheckout = 'project' | 'worktree'

interface NewChatCheckoutChoice {
  checkout: NewChatCheckout
  label: string
  detail: string
  recommended: boolean
}

interface NewChatCheckoutDialogProps {
  projectPath: string
  machineId: string
  recommendedCheckout: NewChatCheckout
  onChoose(checkout: NewChatCheckout): void
  onCancel(): void
}

export function describeNewChatCheckoutChoices(
  recommendedCheckout: NewChatCheckout,
): NewChatCheckoutChoice[] {
  return [
    {
      checkout: 'worktree',
      label: 'New worktree',
      detail: 'Create an isolated branch and checkout for this conversation.',
      recommended: recommendedCheckout === 'worktree',
    },
    {
      checkout: 'project',
      label: 'Project checkout',
      detail: 'Start the conversation in the existing project checkout.',
      recommended: recommendedCheckout === 'project',
    },
  ]
}

function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath
}

export function NewChatCheckoutDialog({
  projectPath,
  machineId,
  recommendedCheckout,
  onChoose,
  onCancel,
}: NewChatCheckoutDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const recommendedRef = useRef<HTMLButtonElement>(null)
  const choices = describeNewChatCheckoutChoices(recommendedCheckout)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => recommendedRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)'))
      if (controls.length === 0) return
      const current = controls.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current === controls.length - 1 ? 0 : current + 1)
      event.preventDefault()
      controls[next].focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [onCancel])

  return (
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '18vh',
      }}
    >
      <section
        ref={dialogRef}
        className="sb-floating-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-checkout-title"
        aria-describedby="new-chat-checkout-detail"
        style={{
          width: 'min(440px, 92vw)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.3)',
        }}
      >
        <header style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="new-chat-checkout-title" style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>
                Choose where to start
              </h2>
              <p id="new-chat-checkout-detail" style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-secondary)' }}>
                {projectName(projectPath)} on {machineId === 'local' ? 'this Mac' : machineId}
              </p>
            </div>
            <button
              type="button"
              aria-label="Cancel new conversation"
              onClick={onCancel}
              style={{
                appearance: 'none',
                border: 0,
                background: 'transparent',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                fontSize: 18,
                lineHeight: 1,
                padding: 2,
              }}
            >
              ×
            </button>
          </div>
        </header>

        <div style={{ padding: 12, display: 'grid', gap: 8 }}>
          {choices.map((choice) => (
            <button
              key={choice.checkout}
              ref={choice.recommended ? recommendedRef : undefined}
              type="button"
              onClick={() => onChoose(choice.checkout)}
              style={{
                appearance: 'none',
                width: '100%',
                minHeight: 62,
                padding: '10px 12px',
                border: `1px solid ${choice.recommended ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 7,
                background: choice.recommended ? 'color-mix(in srgb, var(--accent) 9%, var(--bg-secondary))' : 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                {choice.label}
                {choice.recommended && (
                  <span style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    Recommended
                  </span>
                )}
              </span>
              <span style={{ display: 'block', marginTop: 4, color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.4 }}>
                {choice.detail}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
