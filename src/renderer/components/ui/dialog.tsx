import { forwardRef, useRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cn } from '../../lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description
export const DialogClose = DialogPrimitive.Close

interface DialogContentProps extends ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Classes for the backdrop: its z-index and tint differ per dialog. */
  overlayClassName?: string
}

// Content sits after the overlay in the same stacking context, so it paints
// above it at the same z-index. Position and surface come from the caller.
export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, overlayClassName, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
    const returnFocusTo = useRef<Element | null>(null)
    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn('fixed inset-0 bg-[rgba(0,0,0,0.5)]', overlayClassName)} />
        <DialogPrimitive.Content
          ref={ref}
          className={cn('fixed outline-none', className)}
          onOpenAutoFocus={(event) => {
            returnFocusTo.current = document.activeElement
            onOpenAutoFocus?.(event)
          }}
          // Radix returns focus only to a Dialog.Trigger, and these dialogs open
          // from shortcuts and menus. Return it to whatever had it on open,
          // unless something else has taken it since: a dialog that opens
          // another must leave focus in the new one.
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event)
            const target = returnFocusTo.current
            returnFocusTo.current = null
            if (event.defaultPrevented) return
            event.preventDefault()
            const active = document.activeElement
            if ((!active || active === document.body) && target instanceof HTMLElement && target.isConnected) target.focus()
          }}
          {...props}
        />
      </DialogPrimitive.Portal>
    )
  },
)
DialogContent.displayName = 'DialogContent'
