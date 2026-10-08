import { useRef, useState, type KeyboardEvent } from 'react'
import { effortLabel, type EffortControl } from '@shared/effort'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Effort: High" next to the model chip. The same control for every agent:
 * it lists only the levels the selected model takes (see `shared/effort.ts`)
 * and a pick applies from the next turn.
 */
export function EffortPicker({ control, onPick }: { control: EffortControl; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const options = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = options()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
    items[next]?.focus()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-effort-picker
          title="Thinking effort. A change applies from the next turn."
          className="inline-flex cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[8px] py-[3px] text-[11px] leading-none text-[var(--text-secondary)] outline-none transition-[border-color] duration-[120ms] ease-[ease] data-[state=open]:border-[var(--accent)]"
        >
          <span>
            Effort: <span className="font-[500] text-[var(--text-primary)]">{effortLabel(control.value)}</span>
          </span>
          <span className="text-[9px] text-[var(--text-muted)]">▾</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="Thinking effort"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const items = options()
          ;(items.find((item) => item.getAttribute('aria-selected') === 'true') ?? items[0])?.focus()
        }}
        onEscapeKeyDown={(e) => e.stopPropagation()}
        className="sb-provider-picker z-[1200] w-[210px] rounded-[8px] border border-[var(--border)] p-[4px]"
      >
        <div ref={listRef} role="listbox" aria-label="Thinking effort" onKeyDown={moveFocus} className="flex flex-col gap-[1px]">
          {control.choices.map((choice) => {
            const selected = choice.value === control.value
            return (
              <button
                key={choice.value || '__default__'}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false)
                  if (!selected) onPick(choice.value)
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-[8px] rounded-[5px] border-0 px-[8px] py-[4px] text-left text-[12px] outline-none focus-visible:bg-[var(--bg-tertiary)]',
                  selected
                    ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text-primary)]'
                    : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
                )}
              >
                <span>{choice.label}</span>
                {choice.isDefault && <span className="text-[10px] text-[var(--text-muted)]">default</span>}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
