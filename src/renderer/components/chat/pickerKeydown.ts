/**
 * What a composer keydown does to whichever inline picker is open. Checked in
 * the order the pickers take precedence: the `/send-to` target picker, then
 * @-mentions, then the slash menu.
 *
 * `null` means the picker does not claim the key and the editor handles it.
 * `stopPropagation` is set where the key must not also reach Lexical's own
 * Enter handler.
 */
export type PickerKeyAction =
  | { menu: 'send-to'; op: 'move'; delta: 1 | -1 }
  | { menu: 'send-to'; op: 'pick' | 'dismiss' }
  | { menu: 'at' | 'slash'; op: 'next' | 'prev' | 'dismiss' }
  | { menu: 'at' | 'slash'; op: 'pick'; stopPropagation: true }

export interface PickerKeyState {
  /** Match count when the send-to picker is open, else null. */
  sendToMatches: number | null
  atMatches: number | null
  slashMatches: number | null
}

export function resolvePickerKeydown(
  e: { key: string; altKey: boolean },
  state: PickerKeyState,
): PickerKeyAction | null {
  const isPick = (e.key === 'Enter' && !e.altKey) || e.key === 'Tab'
  // Target picker first: it only opens inside `/send-to`, where the other
  // two triggers cannot be live.
  if (state.sendToMatches !== null && state.sendToMatches > 0) {
    if (e.key === 'ArrowDown') return { menu: 'send-to', op: 'move', delta: 1 }
    if (e.key === 'ArrowUp') return { menu: 'send-to', op: 'move', delta: -1 }
    if (isPick) return { menu: 'send-to', op: 'pick' }
    if (e.key === 'Escape') return { menu: 'send-to', op: 'dismiss' }
  }

  // @-mention branch takes precedence over the slash menu when open.
  if (state.atMatches !== null) {
    // Empty match list: only Escape is meaningful. Letting Enter fall
    // through means the user can still send the typed `@query` literally
    // (matches the slash menu's behaviour at the same code path).
    if (state.atMatches === 0 && e.key !== 'Escape') return null
    if (e.key === 'ArrowDown') return { menu: 'at', op: 'next' }
    if (e.key === 'ArrowUp') return { menu: 'at', op: 'prev' }
    if (e.key === 'Escape') return { menu: 'at', op: 'dismiss' }
    // Swallow Enter/Tab so they don't fire Send / move focus; commit
    // the highlighted row instead.
    if (isPick) return { menu: 'at', op: 'pick', stopPropagation: true }
    // Other keys fall through to the editor (typing extends the query).
    return null
  }

  if (state.slashMatches === null) return null
  if (state.slashMatches === 0 && e.key !== 'Escape') return null
  if (e.key === 'ArrowDown') return { menu: 'slash', op: 'next' }
  if (e.key === 'ArrowUp') return { menu: 'slash', op: 'prev' }
  if (isPick) return { menu: 'slash', op: 'pick', stopPropagation: true }
  if (e.key === 'Escape') return { menu: 'slash', op: 'dismiss' }
  return null
}
