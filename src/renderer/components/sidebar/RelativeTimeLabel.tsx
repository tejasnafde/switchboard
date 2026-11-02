import { useSyncExternalStore } from 'react'
import { formatRelativeTime } from '@shared/format'
import { wakeLabel } from '@shared/chat-snooze'
import { useRenderCount } from '../../services/render-counter'

const MINUTE_MS = 60_000
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

/** One interval for every label on screen: started by the first, stopped by the last. */
function subscribeMinute(listener: () => void): () => void {
  listeners.add(listener)
  timer ??= setInterval(() => listeners.forEach((l) => l()), MINUTE_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS)
}

/**
 * `5m`, `2h`, `3d` for `timestamp`, kept current by a shared minute tick. The
 * tick re-renders this leaf only, so a row that shows it never reads the clock.
 */
export function RelativeTimeLabel({ timestamp, className }: { timestamp: number; className?: string }) {
  useRenderCount('RelativeTimeLabel')
  useSyncExternalStore(subscribeMinute, currentMinute, currentMinute)
  return <span className={className}>{formatRelativeTime(timestamp)}</span>
}

/** A snoozed row's wake time (`20:00`, `Tue 09:00`, `12 Nov`, `PR #512`), on the same minute tick. */
export function WakeTimeLabel({
  until,
  pr,
  className,
}: {
  until: number | null
  pr: string | null
  className?: string
}) {
  useSyncExternalStore(subscribeMinute, currentMinute, currentMinute)
  return <span className={className}>{wakeLabel(until, pr, new Date())}</span>
}
