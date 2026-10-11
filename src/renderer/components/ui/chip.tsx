import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

/**
 * The toolbar chip: 24 px high, radius 6, 11 px text, an optional 12 px icon
 * and a caret. Every control in a `Toolbar` row uses it, so the row lines up
 * and no native <select> sits among the popovers.
 */
export const chipClass =
  'inline-flex h-[24px] shrink-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[8px] text-[11px] leading-none text-[var(--text-secondary)] outline-none transition-[border-color] duration-[120ms] ease-[ease] focus-visible:border-[var(--accent)] data-[state=open]:border-[var(--accent)]'

export const chipValueClass = 'font-[500] text-[var(--text-primary)]'

/** `short` replaces `full` below the toolbar's first step (760 px, see toolbar-steps.ts). */
export function ChipLabel({ full, short }: { full: ReactNode; short?: ReactNode }) {
  if (short === undefined) return <>{full}</>
  return (
    <>
      <span className="@max-[760px]/toolbar:hidden">{full}</span>
      <span className="hidden @max-[760px]/toolbar:inline">{short}</span>
    </>
  )
}

export function ChipCaret() {
  return (
    <span aria-hidden className="text-[9px] text-[var(--text-muted)]">
      ▾
    </span>
  )
}

export interface ChipOption {
  value: string
  label: string
  /** Tooltip on the row, as a native <option title> had. */
  title?: string
  /** Muted text on the right of the row. */
  hint?: string
}

/**
 * A listbox of buttons. It focuses the selected row when it mounts, the arrow
 * keys move between rows (Home and End jump), and Enter or Space picks.
 */
export function OptionList({
  label,
  options,
  value,
  onPick,
  className,
  autoFocus = true,
}: {
  label: string
  options: readonly ChipOption[]
  value: string
  onPick: (value: string) => void
  className?: string
  /** Off for a second list under the first, so focus starts in the first. */
  autoFocus?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])

  useEffect(() => {
    if (!autoFocus) return
    const rows = items()
    ;(rows.find((row) => row.getAttribute('aria-selected') === 'true') ?? rows[0])?.focus()
    // On mount only: a re-render must not move focus.
  }, [])

  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = items()
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, at + 1)
        : e.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? rows.length - 1
              : null
    if (next === null) return
    e.preventDefault()
    rows[next]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      onKeyDown={moveFocus}
      className={cn('flex flex-col gap-[1px]', className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value || '__default__'}
            type="button"
            role="option"
            aria-selected={selected}
            data-value={option.value}
            title={option.title}
            onClick={() => onPick(option.value)}
            className={cn(
              'flex w-full shrink-0 cursor-pointer items-center justify-between gap-[8px] rounded-[5px] border-0 px-[8px] py-[4px] text-left text-[12px] outline-none focus-visible:bg-[var(--bg-tertiary)]',
              selected
                ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text-primary)]'
                : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
            )}
          >
            <span className="min-w-0 truncate">{option.label}</span>
            {option.hint && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{option.hint}</span>}
          </button>
        )
      })}
    </div>
  )
}

export const optionMenuClass = 'sb-provider-picker z-[1200] rounded-[8px] border border-[var(--border)] p-[4px]'

/**
 * A chip that opens a short list, in place of a native <select>. Like
 * one, ArrowUp and ArrowDown on the chip open the list, Escape closes it and
 * focus returns to the chip.
 */
export function ChipSelect({
  label,
  triggerLabel,
  title,
  icon,
  full,
  short,
  options,
  value,
  onPick,
  className,
  valueClassName,
  menuClassName = 'w-[210px]',
  triggerData,
  testId,
}: {
  /** The list's accessible name. */
  label: string
  /** The chip's, when its visible text alone would not say what it sets. */
  triggerLabel?: string
  title?: string
  icon?: ReactNode
  full: ReactNode
  short?: ReactNode
  options: readonly ChipOption[]
  value: string
  onPick: (value: string) => void
  className?: string
  /** For a value that can be long (a branch name): a max width and truncate. */
  valueClassName?: string
  menuClassName?: string
  triggerData?: Record<`data-${string}`, string | undefined>
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          aria-haspopup="listbox"
          title={title}
          data-testid={testId}
          data-value={value}
          {...triggerData}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            setOpen(true)
          }}
          className={cn(chipClass, className)}
        >
          {icon}
          <span className={cn(chipValueClass, valueClassName)}>
            <ChipLabel full={full} short={short} />
          </span>
          <ChipCaret />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={label}
        // OptionList focuses the selected row itself.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.stopPropagation()}
        className={cn(optionMenuClass, menuClassName)}
      >
        <OptionList
          label={label}
          options={options}
          value={value}
          className="max-h-[280px] overflow-y-auto"
          onPick={(next) => {
            setOpen(false)
            if (next !== value) onPick(next)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function DotsIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  )
}
