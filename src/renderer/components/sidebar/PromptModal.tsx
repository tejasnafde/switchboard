import { useEffect, useRef, useState } from 'react'

interface PromptModalProps {
  title: string
  initialValue?: string
  submitLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

/**
 * Minimal in-app text prompt. Electron renderers don't implement
 * window.prompt() (it returns null), so anywhere we need a one-off string
 * without a natural inline-edit anchor uses this instead.
 */
export function PromptModal({ title, initialValue = '', submitLabel = 'OK', onSubmit, onCancel }: PromptModalProps) {
  const [value, setValue] = useState(initialValue)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.select() }, [])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) { onCancel(); return }
    onSubmit(trimmed)
  }

  return (
    <div
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh' }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(420px, 92vw)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
          {title}
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', gap: '6px' }}>
          <input
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }}
            style={{ flex: 1, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '4px', padding: '6px 9px', color: 'var(--text-primary)', fontSize: '12.5px', outline: 'none', fontFamily: 'var(--font-sans)' }}
          />
          <button
            onClick={submit}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
          >{submitLabel}</button>
        </div>
      </div>
    </div>
  )
}
