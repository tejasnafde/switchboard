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
      // The focus ring leaves a 2 px gap in the surface colour, so it reads on an On track of the same blue.
      className={cn(
        'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-[background-color,box-shadow] duration-100 disabled:cursor-default disabled:opacity-50',
        checked
          ? 'bg-[var(--accent)] focus-visible:shadow-[0_0_0_2px_var(--bg-surface),0_0_0_4px_var(--switch-focus)]'
          : 'bg-[var(--switch-off)] shadow-[inset_0_0_0_1px_var(--switch-off-line)] focus-visible:shadow-[inset_0_0_0_1px_var(--switch-off-line),0_0_0_2px_var(--bg-surface),0_0_0_4px_var(--switch-focus)]',
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute rounded-full transition-transform duration-100',
          checked
            ? 'left-[2px] top-[2px] size-[14px] translate-x-[14px] bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
            : 'left-[3px] top-[3px] size-[12px] bg-[var(--switch-off-thumb)]',
        )}
      />
    </button>
  )
}
