/**
 * Pure helpers behind ChatInput's pill-aware text body.
 *
 * Why these exist as pure functions:
 *   - The ChatInput surface is about to flip from `<textarea>` to a
 *     contenteditable div so we can render inline pill chips at the
 *     caret position (Cursor-style). Most of the failure modes live in
 *     the *text representation* — pill tokens, caret arithmetic, and
 *     the wire serialization on Send. Keeping those pure means the
 *     contenteditable surface only owns DOM concerns; the data layer
 *     stays unit-testable under the current node-only vitest setup.
 *
 *   - The token format is `[[pill:<id>]]`. Chosen because:
 *       (a) double brackets don't appear in normal prose or paths,
 *       (b) the id is opaque so we can swap the formatter without
 *           reshaping the token,
 *       (c) easy to grep + visually scan in a draft string.
 */
import { describe, it, expect } from 'vitest'
import { insertPillAtCursor, serializeBodyWithPills } from '../../src/renderer/services/chatInputBody'

describe('insertPillAtCursor', () => {
  it('inserts the token + trailing space into an empty body', () => {
    const r = insertPillAtCursor('', 0, 'a')
    expect(r.body).toBe('[[pill:a]] ')
    expect(r.caret).toBe(r.body.length)
  })

  it('adds a leading space when the previous char is non-whitespace', () => {
    const r = insertPillAtCursor('hi', 2, 'a')
    expect(r.body).toBe('hi [[pill:a]] ')
    expect(r.caret).toBe(r.body.length)
  })

  it('does NOT add a leading space when the previous char is already whitespace', () => {
    const r = insertPillAtCursor('hi ', 3, 'a')
    expect(r.body).toBe('hi [[pill:a]] ')
    expect(r.caret).toBe(r.body.length)
  })

  it('does NOT add a trailing space when the next char is already whitespace', () => {
    const r = insertPillAtCursor('hi world', 2, 'a')
    // 'hi' + ' [[pill:a]]' + ' world'  — leading space added, trailing skipped
    expect(r.body).toBe('hi [[pill:a]] world')
    expect(r.caret).toBe('hi [[pill:a]]'.length)
  })

  it('inserts mid-word, leaves caret immediately after the inserted run', () => {
    const r = insertPillAtCursor('hello', 2, 'a')
    expect(r.body).toBe('he [[pill:a]] llo')
    // caret lands after the trailing space, ready for the next char
    expect(r.caret).toBe('he [[pill:a]] '.length)
  })

  it('clamps caret to [0, length]', () => {
    const r1 = insertPillAtCursor('abc', -5, 'x')
    expect(r1.body.startsWith('[[pill:x]]')).toBe(true)
    const r2 = insertPillAtCursor('abc', 999, 'x')
    expect(r2.body.endsWith('[[pill:x]] ')).toBe(true)
  })

  it('preserves any pre-existing tokens elsewhere in the body', () => {
    const r = insertPillAtCursor('see [[pill:foo]] for', 20, 'bar')
    // caret at end → leading space added (prev is 'r'), no trailing newline
    expect(r.body).toBe('see [[pill:foo]] for [[pill:bar]] ')
  })
})

describe('serializeBodyWithPills', () => {
  it('returns the body unchanged when there are no tokens', () => {
    expect(serializeBodyWithPills('hello world', {})).toBe('hello world')
  })

  it('replaces a single token with its pill content', () => {
    const out = serializeBodyWithPills('see [[pill:a]] for context', {
      a: { id: 'a', kind: 'file', label: 'foo.ts (1-2)', content: '@foo.ts:1-2\n```\nx\n```\n' },
    })
    expect(out).toBe('see @foo.ts:1-2\n```\nx\n```\n for context')
  })

  it('replaces multiple tokens preserving order', () => {
    const out = serializeBodyWithPills('[[pill:a]] and [[pill:b]]', {
      a: { id: 'a', kind: 'file', label: 'A', content: 'AAA' },
      b: { id: 'b', kind: 'file', label: 'B', content: 'BBB' },
    })
    expect(out).toBe('AAA and BBB')
  })

  it('drops tokens whose ids are not in the pill map (treats removed pills as deleted)', () => {
    // User inserted a pill then clicked × — token lingers in the body but
    // the pill is gone. We drop the token rather than leaving raw
    // `[[pill:zz]]` syntax for the agent to puzzle over.
    const out = serializeBodyWithPills('hi [[pill:zz]] there', {})
    expect(out).toBe('hi  there')
  })

  it('preserves pill content verbatim including trailing newlines', () => {
    const out = serializeBodyWithPills('[[pill:a]]', {
      a: { id: 'a', kind: 'terminal', label: 'pane', content: 'LINE1\nLINE2\n' },
    })
    expect(out).toBe('LINE1\nLINE2\n')
  })

  it('does not infinite-loop when pill content itself contains a token-shaped string', () => {
    // Edge case: pill content has `[[pill:b]]` literal in it. We must NOT
    // recursively expand — pills are terminal. The replaced text is opaque.
    const out = serializeBodyWithPills('[[pill:a]]', {
      a: { id: 'a', kind: 'file', label: 'A', content: 'literal [[pill:b]] inside' },
      b: { id: 'b', kind: 'file', label: 'B', content: 'SHOULD_NOT_APPEAR' },
    })
    expect(out).toBe('literal [[pill:b]] inside')
  })
})
