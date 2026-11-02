/** The machine a child runs on when it is not the parent's: its name (and transport), mono and muted. */
export function MachineBadge({ name, transport }: { name: string; transport?: string }) {
  return (
    <span
      data-testid="hub-machine-badge"
      title={`Runs on ${name}`}
      className="inline-block max-w-[140px] shrink-0 truncate rounded-[4px] border border-[var(--border)] px-[4px] align-middle text-[10.5px] leading-[15px] font-[400] text-[var(--text-muted)] [font-family:var(--font-mono)]"
    >
      {transport ? `${name} · ${transport}` : name}
    </span>
  )
}
