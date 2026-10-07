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

// About 230 px per set: ten sets cover a tall display; the extra clips at the top.
const FILL = Array.from({ length: 10 }, () => ROWS).flat()

const SHIMMER = 'animate-shimmer bg-[linear-gradient(90deg,var(--bg-hover)_0%,var(--bg-tertiary)_40%,var(--bg-hover)_80%)] bg-[length:300%_100%] motion-reduce:animate-none'

export function ChatSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-6 py-5">
      <span className="sr-only">{label}</span>
      {FILL.map((row, i) => row.side === 'user'
        ? <div key={i} aria-hidden className={`h-9 shrink-0 self-end rounded-[10px] ${row.widths[0]} ${SHIMMER}`} />
        : (
          <div key={i} aria-hidden className="flex w-[78%] shrink-0 flex-col gap-2">
            {row.widths.map((w) => <div key={w} className={`h-3 rounded-[6px] ${w} ${SHIMMER}`} />)}
          </div>
        ))}
    </div>
  )
}
