import { describe, expect, it } from 'vitest'
import { extractDigest, stripDigest } from '../../src/shared/agent-digest'

describe('extractDigest', () => {
  it('returns undefined for empty text', () => {
    expect(extractDigest('')).toBeUndefined()
  })

  it('returns undefined when no tag is present', () => {
    expect(extractDigest('Just some plain assistant text.')).toBeUndefined()
  })

  it('extracts a single complete tag, trimmed', () => {
    expect(extractDigest('<agent_digest>  Reading config files  </agent_digest>')).toBe(
      'Reading config files',
    )
  })

  it('extracts the tag from surrounding prose', () => {
    const text = 'Sure, let me start.\n<agent_digest>Writing tests</agent_digest>\nHere is the plan...'
    expect(extractDigest(text)).toBe('Writing tests')
  })

  it('returns the LAST complete tag when several are present', () => {
    const text =
      '<agent_digest>Step one</agent_digest> some prose ' +
      '<agent_digest>Step two</agent_digest> more prose ' +
      '<agent_digest>Done: all steps finished</agent_digest>'
    expect(extractDigest(text)).toBe('Done: all steps finished')
  })

  it('ignores an unclosed trailing tag and falls back to the last complete one', () => {
    const text = '<agent_digest>Step one</agent_digest> now streaming <agent_digest>Step tw'
    expect(extractDigest(text)).toBe('Step one')
  })

  it('returns undefined for an unclosed tag with nothing before it', () => {
    expect(extractDigest('<agent_digest>still typing')).toBeUndefined()
  })

  it('skips a whitespace-only digest body', () => {
    expect(extractDigest('<agent_digest>   </agent_digest>')).toBeUndefined()
  })

  it('skips an empty whitespace-only last tag and falls back to an earlier one', () => {
    const text = '<agent_digest>Real status</agent_digest> <agent_digest>   </agent_digest>'
    expect(extractDigest(text)).toBe('Real status')
  })

  it('caps the digest at about 120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const digest = extractDigest(`<agent_digest>${long}</agent_digest>`)
    expect(digest).toBeDefined()
    expect(digest!.length).toBe(120)
    expect(digest!.endsWith('…')).toBe(true)
    expect(digest!.startsWith('x'.repeat(119))).toBe(true)
  })

  it('does not cap a digest exactly at the limit', () => {
    const exact = 'x'.repeat(120)
    expect(extractDigest(`<agent_digest>${exact}</agent_digest>`)).toBe(exact)
  })

  it('handles multiline digest content by trimming outer whitespace only', () => {
    const text = '<agent_digest>\n  Line with inner detail\n</agent_digest>'
    expect(extractDigest(text)).toBe('Line with inner detail')
  })
})

describe('stripDigest - complete-tag removal (both modes)', () => {
  it.each([true, false])('returns falsy input unchanged (streaming: %s)', (streaming) => {
    expect(stripDigest('', { streaming })).toBe('')
  })

  it.each([true, false])('returns text unchanged when no tag is present (streaming: %s)', (streaming) => {
    expect(stripDigest('Just some plain text.', { streaming })).toBe('Just some plain text.')
  })

  it.each([true, false])('removes a single complete tag (streaming: %s)', (streaming) => {
    expect(stripDigest('Hello <agent_digest>Working</agent_digest> world', { streaming })).toBe(
      'Hello  world',
    )
  })

  it.each([true, false])('removes multiple complete tags (streaming: %s)', (streaming) => {
    const text =
      '<agent_digest>Step one</agent_digest>body one' +
      '<agent_digest>Step two</agent_digest>body two'
    expect(stripDigest(text, { streaming })).toBe('body onebody two')
  })
})

describe('stripDigest - streaming: true (still typing in)', () => {
  it('hides a fully unclosed trailing tag and its partial body', () => {
    expect(stripDigest('Working on it. <agent_digest>Writing te', { streaming: true })).toBe(
      'Working on it. ',
    )
  })

  it('hides an unclosed tag with a partial close tag in progress', () => {
    expect(
      stripDigest('Working on it. <agent_digest>Writing tests</agent_dig', { streaming: true }),
    ).toBe('Working on it. ')
  })

  it('hides a bare partial prefix of the open tag at the end of the text', () => {
    expect(stripDigest('Working on it. <agent_di', { streaming: true })).toBe('Working on it. ')
  })

  it('hides the shortest partial prefix: a single trailing "<"', () => {
    expect(stripDigest('Working on it. <', { streaming: true })).toBe('Working on it. ')
  })

  it('does not touch a "<" that is not followed by tag-prefix characters', () => {
    expect(stripDigest('if (x < 5) return', { streaming: true })).toBe('if (x < 5) return')
  })

  it('does not touch an unrelated trailing angle-bracket tag', () => {
    expect(stripDigest('some <b>bold</b> text', { streaming: true })).toBe('some <b>bold</b> text')
  })

  it('keeps prose between a complete tag and a later unclosed one', () => {
    const text = '<agent_digest>first</agent_digest> body text <agent_digest>second'
    expect(stripDigest(text, { streaming: true })).toBe(' body text ')
  })

  it('progressively strips a tag as it streams in, character by character', () => {
    const full = 'Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_digest>'
    const prefixesThatShouldAllHideTheTag = [
      'Working on it. <',
      'Working on it. <a',
      'Working on it. <agent_dig',
      'Working on it. <agent_digest>',
      'Working on it. <agent_digest>Writing',
      'Working on it. <agent_digest>Writing tests, 2 of 4 done',
      'Working on it. <agent_digest>Writing tests, 2 of 4 done</agent_dig',
    ]
    for (const partial of prefixesThatShouldAllHideTheTag) {
      expect(stripDigest(partial, { streaming: true })).toBe('Working on it. ')
    }
    expect(stripDigest(full, { streaming: true })).toBe('Working on it. ')
  })
})

describe('stripDigest - streaming: false (finished message)', () => {
  // Regression (CodeRabbit, PR #105): a FINISHED message that merely quotes
  // the literal `<agent_digest>` string, with no close tag, used to lose
  // everything after it - in the chat transcript, on copy, on mobile, and
  // on Android. A finished message cannot still be "mid-tag", so only
  // complete pairs are ever removed.

  it('does not touch an unclosed tag - nothing more can arrive for a finished message', () => {
    expect(stripDigest('Working on it. <agent_digest>Writing te', { streaming: false })).toBe(
      'Working on it. <agent_digest>Writing te',
    )
  })

  it('leaves a literal, quoted open tag with no close alone', () => {
    // The exact case from the report: this file's own OPEN_TAG constant,
    // quoted in prose or code, in an already-finished message.
    const text = "const OPEN_TAG = '<agent_digest>'"
    expect(stripDigest(text, { streaming: false })).toBe(text)
  })

  it('leaves a bare partial prefix of the open tag alone', () => {
    expect(stripDigest('Working on it. <agent_di', { streaming: false })).toBe(
      'Working on it. <agent_di',
    )
  })

  it('leaves a trailing "<" alone', () => {
    expect(stripDigest('Working on it. <', { streaming: false })).toBe('Working on it. <')
  })

  it('still removes a complete tag pair even when a later, unclosed one follows', () => {
    const text = '<agent_digest>first</agent_digest> body text <agent_digest>second'
    expect(stripDigest(text, { streaming: false })).toBe(' body text <agent_digest>second')
  })
})
