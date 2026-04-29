/**
 * Round-trip parser for the chat input's wire body string.
 *
 * The Lexical editor renders pill chips inline. To hydrate the editor
 * from a saved draft (which is just a `string` in `draft-store.drafts`),
 * we split the string into a sequence of `{type:'text', text}` and
 * `{type:'pill', id}` segments. Lexical builds one node per segment.
 *
 * This is the inverse of `serializeBodyWithPills` (which expands tokens
 * into pill content for the wire). Pure + node-testable so the editor
 * surface only owns DOM concerns.
 */
import { describe, it, expect } from 'vitest'
import { parseBodyToSegments } from '../../src/renderer/services/chatInputBody'

describe('parseBodyToSegments', () => {
  it('returns a single text segment when the body contains no tokens', () => {
    expect(parseBodyToSegments('hello world')).toEqual([
      { type: 'text', text: 'hello world' },
    ])
  })

  it('returns an empty array when the body is empty', () => {
    expect(parseBodyToSegments('')).toEqual([])
  })

  it('splits around a single token', () => {
    expect(parseBodyToSegments('see [[pill:a]] for context')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'pill', id: 'a' },
      { type: 'text', text: ' for context' },
    ])
  })

  it('handles a token at the start of the body', () => {
    expect(parseBodyToSegments('[[pill:a]] then text')).toEqual([
      { type: 'pill', id: 'a' },
      { type: 'text', text: ' then text' },
    ])
  })

  it('handles a token at the end of the body', () => {
    expect(parseBodyToSegments('text before [[pill:a]]')).toEqual([
      { type: 'text', text: 'text before ' },
      { type: 'pill', id: 'a' },
    ])
  })

  it('handles adjacent tokens without intervening text', () => {
    expect(parseBodyToSegments('[[pill:a]][[pill:b]]')).toEqual([
      { type: 'pill', id: 'a' },
      { type: 'pill', id: 'b' },
    ])
  })

  it('handles multiple tokens with text between them', () => {
    expect(parseBodyToSegments('a [[pill:x]] b [[pill:y]] c')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'pill', id: 'x' },
      { type: 'text', text: ' b ' },
      { type: 'pill', id: 'y' },
      { type: 'text', text: ' c' },
    ])
  })

  it('treats malformed tokens as plain text (regression — the parser must not eat brackets)', () => {
    // Single bracket, no closing — leave alone.
    expect(parseBodyToSegments('[pill:a]')).toEqual([
      { type: 'text', text: '[pill:a]' },
    ])
    // Mismatched id chars (whitespace) — not a token.
    expect(parseBodyToSegments('[[pill:a b]]')).toEqual([
      { type: 'text', text: '[[pill:a b]]' },
    ])
  })
})
