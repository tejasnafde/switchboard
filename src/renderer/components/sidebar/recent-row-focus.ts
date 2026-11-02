/** Keyboard focus between Recents rows, which re-render when one is settled or restored. */

/** The id to focus after `id` leaves the list: the next row, else the previous one, else none. */
export function neighbourAfterRemoval(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id)
  if (index < 0) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

/** Focus a Recents row once the list has re-rendered. */
export function focusRecentRow(id: string): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`.sidebar-recent-row-button[data-recent-id="${CSS.escape(id)}"]`)?.focus()
  })
}
