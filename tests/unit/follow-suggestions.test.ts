import { describe, expect, it } from 'vitest'
import {
  followOffNotice,
  followSuggestionView,
  followSuggestionsOff,
  parseFollowSuggestionMode,
  recordWorkedWorktree,
} from '@shared/follow-suggestions'

describe('follow suggestions', () => {
  it('shows the chip until a chat has worked in more than two worktrees', () => {
    expect(followSuggestionView('auto', 1)).toEqual({ kind: 'chip' })
    expect(followSuggestionView('auto', 2)).toEqual({ kind: 'chip' })
    expect(followSuggestionView('auto', 3)).toEqual({ kind: 'off', reason: 'many-worktrees', count: 3 })
  })
  it('lets "Turn back on" override the cut-off, and "Not in this chat" win over everything', () => {
    expect(followSuggestionView('on', 9)).toEqual({ kind: 'chip' })
    expect(followSuggestionView('muted', 0)).toEqual({ kind: 'off', reason: 'muted' })
  })
  it('keeps a dismissed notice hidden however many worktrees the chat works in', () => {
    for (const count of [3, 4, 10, 32]) {
      expect(followSuggestionView('auto', count, true)).toEqual({ kind: 'hidden' })
    }
    expect(followSuggestionView('muted', 0, true)).toEqual({ kind: 'hidden' })
  })
  it('never hides the chip itself: dismissing applies to the off notice only', () => {
    expect(followSuggestionView('auto', 2, true)).toEqual({ kind: 'chip' })
    expect(followSuggestionView('on', 9, true)).toEqual({ kind: 'chip' })
  })
  it('restores the chip on "Turn back on", which clears the dismissal', () => {
    expect(followSuggestionsOff('auto', 5)).toBe(true)
    expect(followSuggestionsOff('muted', 0)).toBe(true)
    expect(followSuggestionsOff('auto', 2)).toBe(false)
    expect(followSuggestionsOff('on', 5)).toBe(false)
    expect(followSuggestionView('on', 5, false)).toEqual({ kind: 'chip' })
  })
  it('says why it is off', () => {
    expect(followOffNotice({ kind: 'off', reason: 'many-worktrees', count: 5 }))
      .toBe('Follow suggestions are off for this chat: it has worked in 5 worktrees.')
    expect(followOffNotice({ kind: 'off', reason: 'muted' })).toBe('Follow suggestions are off for this chat.')
  })
  it('reads anything unknown as auto', () => {
    expect(parseFollowSuggestionMode(null)).toBe('auto')
    expect(parseFollowSuggestionMode('loud')).toBe('auto')
    expect(parseFollowSuggestionMode('muted')).toBe('muted')
  })
  it('counts distinct worktrees, ignoring a trailing slash', () => {
    let worked = recordWorkedWorktree([], '/repo')
    worked = recordWorkedWorktree(worked, '/repo/')
    worked = recordWorkedWorktree(worked, '/wt/a')
    expect(worked).toEqual(['/repo', '/wt/a'])
    expect(recordWorkedWorktree(worked, '/wt/a')).toBe(worked)
  })
})
