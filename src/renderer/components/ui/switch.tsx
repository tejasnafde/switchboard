import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '../../lib/utils'

/** An on/off switch. Label it with `aria-label` or `aria-labelledby`. */
export function Switch({
  checked,
  onCheckedChange,
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'onClick' | 'role' | 'type'> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
        checked ? 'bg-[var(--accent)]' : 'bg-[rgba(128,128,128,0.35)]',
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[2px] top-[2px] size-[14px] rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-100',
          checked && 'translate-x-[14px]',
        )}
      />
    </button>
  )
}
