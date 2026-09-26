import { useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { filterComboboxOptions, groupComboboxOptions, type ComboboxOption } from './combobox-options'

export type { ComboboxOption } from './combobox-options'

interface ComboboxProps {
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  /** Off for a short fixed list: no search box, arrows and Enter still work. */
  searchable?: boolean
  /** Trigger text when `value` matches no option. */
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  id?: string
  title?: string
  'aria-label'?: string
  /** Trigger classes, merged over the defaults. */
  className?: string
  contentClassName?: string
  /** Call `event.preventDefault()` to keep focus off the trigger after a pick. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * A select-like trigger that opens a filterable list (cmdk inside a Radix
 * popover). Filtering is ours, not cmdk's, so the list keeps the order the
 * caller gave it. Escape or a pick closes it and Radix returns focus to the
 * trigger.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  searchable = true,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabled,
  id,
  title,
  'aria-label': ariaLabel,
  className,
  contentClassName,
  onCloseAutoFocus,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => option.value === value)
  const groups = useMemo(
    () => groupComboboxOptions(searchable ? filterComboboxOptions(options, query) : options),
    [options, query, searchable],
  )

  return (
    <Popover
      // Modal so its own scroll lock wins over the one Settings holds; the
      // list would not scroll with the wheel otherwise.
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          title={title}
          role="combobox"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn(
            'inline-flex min-w-0 cursor-pointer items-center justify-between gap-2 rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-2 py-1 text-left text-[12px] text-[var(--text-primary)] outline-none hover:border-[var(--border-focus)] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !selected && 'text-[var(--text-muted)]')}>{selected?.label ?? placeholder}</span>
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-muted)]">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={ariaLabel}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(searchable ? inputRef.current : rootRef.current)?.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        className={cn(
          'sb-floating-surface z-[1200] min-w-[var(--radix-popover-trigger-width)] max-w-[360px] overflow-hidden rounded-[8px] border border-[var(--border)]',
          contentClassName,
        )}
      >
        <Command ref={rootRef} tabIndex={-1} shouldFilter={false} loop defaultValue={value} label={ariaLabel} className="outline-none">
          {searchable && (
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder}
              className="w-full border-0 border-b border-solid border-b-[var(--border)] bg-transparent px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          )}
          <Command.List className="max-h-[280px] overflow-y-auto p-1">
            <Command.Empty className="px-2 py-3 text-center text-[12px] text-[var(--text-muted)]">{emptyText}</Command.Empty>
            {groups.map((group) => (
              <Command.Group
                key={group.heading ?? ''}
                heading={group.heading}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-[600] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-[var(--text-muted)]"
              >
                {group.options.map((option) => (
                  <Command.Item
                    key={option.value}
                    value={option.value}
                    onSelect={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-[5px] text-[12px] text-[var(--text-primary)] data-[selected=true]:bg-[var(--bg-hover)]"
                  >
                    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0 text-[var(--accent)]', option.value !== value && 'invisible')}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{option.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
