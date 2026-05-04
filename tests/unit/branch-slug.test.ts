import { describe, it, expect } from 'vitest'
import { makeBranchSlug, slugifyForBranch } from '@shared/branchSlug'

describe('slugifyForBranch', () => {
  it.each([
    ['Fix Redis timeout in worker pool', 'fix-redis-timeout-in-worker-pool'],
    ['  leading and trailing whitespace   ', 'leading-and-trailing-whitespace'],
    ['Punctuation!! goes ?? away.', 'punctuation-goes-away'],
    ['UPPER → lower', 'upper-lower'],
    ['emoji 🚀 stripped', 'emoji-stripped'],
    ['multiple    spaces  collapse', 'multiple-spaces-collapse'],
    ['underscores_become-dashes', 'underscores-become-dashes'],
    // Slice happens before the final trailing-dash trim so a cut that
    // lands on a hyphen-separator doesn't leave a hanging hyphen.
    ['a'.repeat(60), 'a'.repeat(40)],
    // The 40-char slice lands exactly on a separator dash here; the
    // trailing-dash strip drops it, giving 39 clean chars.
    ['abcdefghij klmnopqrs uvwxyz0123 abcdefg x', 'abcdefghij-klmnopqrs-uvwxyz0123-abcdefg'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(slugifyForBranch(input)).toBe(expected)
  })

  it('falls back to "fork" for empty / all-punctuation input', () => {
    expect(slugifyForBranch('')).toBe('fork')
    expect(slugifyForBranch('!!!')).toBe('fork')
    expect(slugifyForBranch('   ')).toBe('fork')
  })
})

describe('makeBranchSlug', () => {
  it('prefixes with `fork/`', () => {
    expect(makeBranchSlug('Fix Redis timeout')).toBe('fork/fix-redis-timeout')
  })

  it('handles empty input gracefully', () => {
    expect(makeBranchSlug('')).toBe('fork/fork')
  })
})
