/**
 * The drift chip ("Agent is working in <branch>  Follow") per conversation.
 * `auto` shows it until the chat has worked in more than
 * `FOLLOW_AUTO_OFF_ABOVE` distinct worktrees: an orchestrating chat touches a
 * new worktree each turn and has no single home branch to follow. `muted` is
 * the user's "Not in this chat"; `on` is "Turn back on", which also overrides
 * the automatic cut-off.
 */
export type FollowSuggestionMode = 'auto' | 'muted' | 'on'

export const FOLLOW_AUTO_OFF_ABOVE = 2

/** Enough to know the count passed the cut-off, small enough for one column. */
const WORKED_WORKTREES_CAP = 32

export function parseFollowSuggestionMode(value: unknown): FollowSuggestionMode {
  return value === 'muted' || value === 'on' ? value : 'auto'
}

/** Add a worktree path to the ones a chat has worked in, keeping them distinct. */
export function recordWorkedWorktree(worked: readonly string[], path: string): readonly string[] {
  const normalized = path.replace(/\/+$/, '')
  if (!normalized || worked.includes(normalized) || worked.length >= WORKED_WORKTREES_CAP) return worked
  return [...worked, normalized]
}

export type FollowSuggestionView =
  | { kind: 'chip' }
  | { kind: 'off'; reason: 'muted' }
  | { kind: 'off'; reason: 'many-worktrees'; count: number }

export function followSuggestionView(mode: FollowSuggestionMode, workedWorktrees: number): FollowSuggestionView {
  if (mode === 'muted') return { kind: 'off', reason: 'muted' }
  if (mode === 'auto' && workedWorktrees > FOLLOW_AUTO_OFF_ABOVE) {
    return { kind: 'off', reason: 'many-worktrees', count: workedWorktrees }
  }
  return { kind: 'chip' }
}

/** The one line shown in place of the chip when suggestions are off. */
export function followOffNotice(view: Extract<FollowSuggestionView, { kind: 'off' }>): string {
  return view.reason === 'muted'
    ? 'Follow suggestions are off for this chat.'
    : `Follow suggestions are off for this chat: it has worked in ${view.count} worktrees.`
}
