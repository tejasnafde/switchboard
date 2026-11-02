import { cn } from '../../lib/utils'

/**
 * The one loading spinner: a ring in the current text colour with a gap,
 * turning once a second, still under reduced motion. Colour and border width
 * come from `className`; `label` makes it a status for screen readers,
 * otherwise it is decoration next to text that says what is loading.
 */
export function Spinner({ size = 12, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      style={{ width: size, height: size }}
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none',
        className,
      )}
    />
  )
}
