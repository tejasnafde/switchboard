import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/** A single-line text field. `aria-invalid` draws the error border. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-8 w-full min-w-0 rounded-md border border-border bg-[var(--bg-secondary)] px-2.5 text-[13px] text-foreground outline-none placeholder:text-[var(--text-muted)] focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_var(--accent-subtle)] disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive/60',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
