import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '../../lib/utils'

/** A segmented control: one track, the pressed item raised. */
export const ToggleGroup = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn('inline-flex gap-0.5 rounded-[7px] border border-border bg-[var(--bg-secondary)] p-0.5', className)}
    {...props}
  />
))
ToggleGroup.displayName = 'ToggleGroup'

export const ToggleGroupItem = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      'h-6 cursor-pointer rounded-[5px] border-0 bg-transparent px-2.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground',
      className,
    )}
    {...props}
  />
))
ToggleGroupItem.displayName = 'ToggleGroupItem'
