import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '../../lib/utils'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor

// Portalled to <body>, so the content escapes any overflow:hidden composer.
// No surface styling here: each popover brings its own (most use
// sb-floating-surface for the per-theme opaque background).
export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, onFocusOutside, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn('outline-none', className)}
      // Switching to another app moves focus onto one of the focus guards
      // Radix puts at the edges of <body>, which reads as focus outside and
      // closed the popover. Only focus on a real element may dismiss it.
      onFocusOutside={(event) => {
        onFocusOutside?.(event)
        if (event.target instanceof Element && event.target.hasAttribute('data-radix-focus-guard')) event.preventDefault()
      }}
      {...props}
    />
  </PopoverPrimitive.Portal>
))
PopoverContent.displayName = 'PopoverContent'
