/** Stroke icons of the HTML preview pane (16-unit grid, currentColor). */
const PATHS = {
  reload: ['M13.5 8a5.5 5.5 0 1 1-1.6-3.9', 'M13.5 2.5v3h-3'],
  external: [
    'M9 2.5h4.5V7',
    'M13.5 2.5 7.5 8.5',
    'M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7',
  ],
  close: ['M4 4l8 8M12 4l-8 8'],
  shield: ['M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z'],
  sun: ['M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1'],
  moon: ['M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z'],
  file: [
    'M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z',
    'M9.5 1.5V5H13',
    'm6 8-1.5 1.5L6 11M10 8l1.5 1.5L10 11',
  ],
  check: ['M3 8.5 6.5 12 13 4.5'],
  alert: ['M8 4.8v4M8 11.2v.1'],
  off: ['m3.5 3.5 9 9'],
} as const

export type PreviewIconName = keyof typeof PATHS | 'dots'

export function PreviewIcon({ name, className }: { name: PreviewIconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`shrink-0 fill-none stroke-current stroke-[1.6] [stroke-linecap:round] [stroke-linejoin:round] ${className ?? 'size-[13px]'}`}
    >
      {name === 'dots' ? (
        <>
          <circle cx="3.5" cy="8" r=".9" />
          <circle cx="8" cy="8" r=".9" />
          <circle cx="12.5" cy="8" r=".9" />
        </>
      ) : (
        <>
          {(name === 'sun' || name === 'alert' || name === 'off') && (
            <circle cx="8" cy="8" r={name === 'sun' ? 3 : 6.5} />
          )}
          {PATHS[name].map((d) => (
            <path key={d} d={d} />
          ))}
        </>
      )}
    </svg>
  )
}
