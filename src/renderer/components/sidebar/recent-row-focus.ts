/** Keyboard focus between Recents rows, which re-render when one is settled or restored. */

/** The id to focus after `id` leaves the list: the next row, else the previous one, else none. */
export function neighbourAfterRemoval(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id)
  if (index < 0) return null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

/** The Snoozed group's header, which holds focus for a row the shut group does not show. */
export const SNOOZED_GROUP_TOGGLE = '.sidebar-recent-group[data-group="snoozed"] .sidebar-recent-group-toggle'

/** Focus a Recents row once the list has re-rendered, or `fallback` when the row is not shown. */
export function focusRecentRow(id: string, fallback?: string): void {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`.sidebar-recent-row-button[data-recent-id="${CSS.escape(id)}"]`)
    const target = row ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null)
    target?.focus()
  })
}

/** Focus the row an Undo restored; an Undo of a Wake puts the chat back in the Snoozed group, which can be shut. */
export function focusUndoneRow(id: string, kind: 'settle' | 'snooze' | 'wake'): void {
  focusRecentRow(id, kind === 'wake' ? SNOOZED_GROUP_TOGGLE : undefined)
}
