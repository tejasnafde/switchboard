import { cn } from '../../lib/utils'
import { Spinner } from './spinner'

export function LoadingStatus({
  label,
  error = false,
  fill = false,
}: {
  label: string
  error?: boolean
  fill?: boolean
}) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-live="polite"
      className={cn(
        'flex items-center justify-center gap-2 px-4 py-3 text-xs text-muted-foreground',
        fill && 'min-h-0 flex-1',
        error && 'text-destructive',
      )}
    >
      {!error && <Spinner />}
      <span>{label}</span>
    </div>
  )
}
