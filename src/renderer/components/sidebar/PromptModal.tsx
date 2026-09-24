import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

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

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) { onCancel(); return }
    onSubmit(trimmed)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ref.current?.focus()
          ref.current?.select()
        }}
        overlayClassName="z-[1300]"
        className="sb-floating-surface inset-x-0 top-[18vh] z-[1300] mx-auto w-[min(420px,92vw)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
      >
        <DialogTitle className="border-b border-[var(--border)] px-[14px] py-[10px] text-[12px] font-[600] text-[var(--text-secondary)]">
          {title}
        </DialogTitle>
        <div className="flex gap-[6px] px-[14px] py-[12px]">
          <input
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
            }}
            className="flex-1 rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[9px] py-[6px] text-[12.5px] [font-family:var(--font-sans)] text-[var(--text-primary)] outline-none"
          />
          <button
            onClick={submit}
            className="cursor-pointer rounded-[4px] border-0 bg-[var(--accent)] px-[12px] py-[5px] text-[12px] text-[#fff]"
          >{submitLabel}</button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
