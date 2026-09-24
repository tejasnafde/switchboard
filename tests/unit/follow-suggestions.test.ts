import { describe, expect, it } from 'vitest'
import {
  followOffNotice,
  followSuggestionView,
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
