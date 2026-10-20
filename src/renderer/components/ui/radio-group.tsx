import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '../../lib/utils'

export const RadioGroup = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => <RadioGroupPrimitive.Root ref={ref} className={cn('grid', className)} {...props} />)
RadioGroup.displayName = 'RadioGroup'

/**
 * A selectable card rather than a dot: the caller renders its content, and
 * the checked card gets the accent border, tint and corner dot.
 */
export const RadioGroupCard = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex min-w-0 cursor-pointer items-center gap-[9px] rounded-[8px] border border-border bg-[var(--bg-surface)] p-2.5 text-left text-foreground outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-elevated)] data-[state=checked]:border-primary data-[state=checked]:bg-[var(--accent-subtle)]',
      className,
    )}
    {...props}
  >
    {children}
    <RadioGroupPrimitive.Indicator className="absolute top-2 right-2 size-1.5 rounded-full bg-primary-fill" />
  </RadioGroupPrimitive.Item>
))
RadioGroupCard.displayName = 'RadioGroupCard'
