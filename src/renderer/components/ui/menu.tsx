/**
 * A small action menu on the Radix Popover (shadcn style): labelled groups,
 * separators, items with an optional check and hint. Radix focuses the first
 * item on open and owns Escape, outside clicks and focus return; Up/Down move
 * between items, Home/End jump.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type KeyboardEvent, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { cn } from '../../lib/utils'

export const Menu = Popover
export const MenuTrigger = PopoverTrigger

function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'))
  if (items.length === 0) return
  event.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length
  items[next].focus()
}

export const MenuContent = forwardRef<
  ElementRef<typeof PopoverContent>,
  ComponentPropsWithoutRef<typeof PopoverContent>
>(({ className, onKeyDown, align = 'end', sideOffset = 4, ...props }, ref) => (
  <PopoverContent
    ref={ref}
    role="menu"
    align={align}
    sideOffset={sideOffset}
    onKeyDown={(event) => {
      onKeyDown?.(event)
      moveFocus(event)
    }}
    className={cn(
      'sb-floating-surface z-[1200] min-w-[180px] rounded-[8px] border border-[var(--border-strong)] p-[4px] text-[12.5px] shadow-[0_6px_24px_rgba(0,0,0,0.45)]',
      className,
    )}
    {...props}
  />
))
MenuContent.displayName = 'MenuContent'

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-[8px] pt-[6px] pb-[2px] text-[11px] text-[var(--text-muted)]">{children}</div>
}

export function MenuSeparator() {
  return <div role="separator" className="my-[4px] border-t border-[var(--border)]" />
}

interface MenuItemProps extends Omit<ComponentPropsWithoutRef<'button'>, 'type'> {
  checked?: boolean
  hint?: string
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  ({ className, checked, hint, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={cn(
        'flex w-full cursor-pointer items-center justify-between gap-[8px] rounded-[5px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[var(--text-primary)] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-[6px]">
        {children}
        {hint && <span className="text-[11.5px] text-[var(--text-muted)]">{hint}</span>}
      </span>
      {checked && (
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-[12px] shrink-0 fill-none stroke-current stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round]"
        >
          <path d="M3 8.5 6.5 12 13 4.5" />
        </svg>
      )}
    </button>
  ),
)
MenuItem.displayName = 'MenuItem'
