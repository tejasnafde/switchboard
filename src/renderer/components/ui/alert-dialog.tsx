import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { cn } from '../../lib/utils'

export const AlertDialog = AlertDialogPrimitive.Root
export const AlertDialogAction = AlertDialogPrimitive.Action
export const AlertDialogCancel = AlertDialogPrimitive.Cancel

// Above every app modal (the highest is z-index 2000), because a confirm can
// open from inside Settings or a kanban card.
export const AlertDialogContent = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[3000] bg-[rgba(0,0,0,0.5)]" />
    <AlertDialogPrimitive.Content
      ref={ref}
      // sb-floating-surface gives it the opaque per-theme surface (and the
      // translucent theme's blurred one) that every other popover uses.
      className={cn(
        'sb-floating-surface fixed left-1/2 top-1/2 z-[3001] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-lg)] border border-border p-5 text-foreground outline-none',
        className,
      )}
      {...props}
    />
  </AlertDialogPrimitive.Portal>
))
AlertDialogContent.displayName = 'AlertDialogContent'

export const AlertDialogTitle = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title ref={ref} className={cn('whitespace-pre-line text-[14px] font-[600]', className)} {...props} />
))
AlertDialogTitle.displayName = 'AlertDialogTitle'

export const AlertDialogDescription = forwardRef<
  ElementRef<typeof AlertDialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn('mt-2 whitespace-pre-line text-[13px] leading-[1.5] text-muted-foreground', className)}
    {...props}
  />
))
AlertDialogDescription.displayName = 'AlertDialogDescription'
