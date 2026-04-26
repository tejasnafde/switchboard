import { describe, it, expect } from 'vitest'
import { generateTitle } from '../../src/shared/auto-title'

describe('generateTitle', () => {
  it('returns short message as-is', () => {
    expect(generateTitle('Fix the login bug')).toBe('Fix the login bug')
  })

  it('truncates long message at word boundary', () => {
    const long = 'Please refactor the authentication middleware to use JWT tokens instead of session cookies for better scalability'
    const title = generateTitle(long)
    expect(title.length).toBeLessThanOrEqual(51) // 50 + ellipsis
    expect(title).toContain('\u2026')
    expect(title).not.toMatch(/\s\u2026/) // no trailing space before ellipsis
  })

  it('strips code blocks', () => {
    const msg = 'Fix this:\n```\nconst x = 1\n```\nplease'
    expect(generateTitle(msg)).toBe('Fix this: please')
  })

  it('strips inline code', () => {
    expect(generateTitle('Change `foo` to `bar`')).toBe('Change to')
  })

  it('collapses whitespace', () => {
    expect(generateTitle('Fix   the\n\nbug')).toBe('Fix the bug')
  })

  it('returns default for empty message', () => {
    expect(generateTitle('')).toBe('New conversation')
    expect(generateTitle('```\nonly code\n```')).toBe('New conversation')
  })

  it('respects custom maxLength', () => {
    const title = generateTitle('This is a somewhat longer message that needs truncation', 20)
    expect(title.length).toBeLessThanOrEqual(21)
  })
})
