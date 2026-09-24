import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// Every variant carries a 1px border (transparent unless outline) so all of
// them share one box size at a given `size`.
const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent font-[600] outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:border-transparent disabled:bg-muted disabled:text-[var(--text-muted)] aria-disabled:cursor-default aria-disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/85',
        outline: 'border-border bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        'destructive-outline': 'border-destructive/60 bg-transparent text-destructive hover:bg-destructive/10',
      },
      size: {
        default: 'h-9 px-4 text-[13px]',
        sm: 'h-7 px-2.5 text-[12px]',
        lg: 'h-10 px-5 text-[14px]',
        icon: 'size-9',
        /** 28px round icon button, for compact toolbars like the composer. */
        'icon-round': 'size-7 rounded-full p-0',
        /** 22px square icon button, for inline row actions. */
        'icon-xs': 'size-5.5 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp ref={ref} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  },
)
Button.displayName = 'Button'
