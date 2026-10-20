import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { cn } from '../../lib/utils'

export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex size-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-[var(--text-muted)] bg-transparent p-0 text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 data-[state=checked]:border-primary-fill data-[state=checked]:bg-primary-fill',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <svg viewBox="0 0 16 16" className="size-[10px]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = 'Checkbox'
