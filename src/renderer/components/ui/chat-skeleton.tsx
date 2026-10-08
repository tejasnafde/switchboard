/**
 * Message-shaped placeholders while a conversation loads. A chat sits at the
 * bottom, by the composer, so the rows anchor there and fill the pane; the
 * extra rows clip at the top.
 */
const ROWS: Array<{ side: 'user' | 'agent'; widths: string[] }> = [
  { side: 'user', widths: ['w-[46%]'] },
  { side: 'agent', widths: ['w-[92%]', 'w-[84%]', 'w-[60%]'] },
  { side: 'user', widths: ['w-[34%]'] },
  { side: 'agent', widths: ['w-[88%]', 'w-[70%]'] },
]

/** Height of one set of ROWS with its gaps, in CSS px: rows 36 + 52 + 36 + 32, four 16 px gaps. */
const SET_PX = 220

/**
 * Enough sets to fill a pane of `height` px, plus one. The pane is never taller
 * than the screen its window is on, so the screen height covers every display
 * size and orientation without measuring the pane.
 */
export function skeletonSets(height: number): number {
  return Math.ceil(Math.max(height, 0) / SET_PX) + 1
}

const SHIMMER =
  'animate-shimmer bg-[linear-gradient(90deg,var(--bg-hover)_0%,var(--bg-tertiary)_40%,var(--bg-hover)_80%)] bg-[length:300%_100%] motion-reduce:animate-none'

export function ChatSkeleton({ label }: { label: string }) {
  const fill = Array.from({ length: skeletonSets(window.screen.height) }, () => ROWS).flat()
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-6 py-5"
    >
      <span className="sr-only">{label}</span>
      {fill.map((row, i) =>
        row.side === 'user' ? (
          <div key={i} aria-hidden className={`h-9 shrink-0 self-end rounded-[10px] ${row.widths[0]} ${SHIMMER}`} />
        ) : (
          <div key={i} aria-hidden className="flex w-[78%] shrink-0 flex-col gap-2">
            {row.widths.map((w) => (
              <div key={w} className={`h-3 rounded-[6px] ${w} ${SHIMMER}`} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}
